'use strict';

// Durable broker-call audit records. This deliberately captures delivery content only after
// removing credential-shaped fields and bounds every value so the audit table cannot become a
// secret store or an unbounded payload archive.
const { TableClient } = require('@azure/data-tables');
const { DefaultAzureCredential } = require('@azure/identity');
const crypto = require('node:crypto');
const scrubber = require('./credential-scrubber');

const MAX_CONTENT_BYTES = 8 * 1024;
const TABLE_NAME = process.env.BROKER_AUDIT_TABLE_NAME || 'operatorAudit';
const ACCOUNT = process.env.BROKER_AUDIT_STORAGE_ACCOUNT;
const ENDPOINT = process.env.BROKER_AUDIT_TABLE_ENDPOINT || (ACCOUNT ? `https://${ACCOUNT}.table.core.windows.net` : null);
let client;

function boundedText(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value || ''), 'utf8');
  const truncated = bytes.subarray(0, MAX_CONTENT_BYTES);
  return { value: truncated.toString('utf8'), truncated: bytes.length > MAX_CONTENT_BYTES };
}
async function captureRequestContent(request) {
  const type = request.headers.get('content-type') || '';
  if (!request.body || request.method === 'GET' || request.method === 'HEAD') return { value: '', truncated: false, contentType: type };
  try {
    const reader = request.clone().body.getReader();
    const chunks = [];
    let size = 0;
    let truncated = false;
    while (size <= MAX_CONTENT_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      const remaining = MAX_CONTENT_BYTES + 1 - size;
      chunks.push(chunk.subarray(0, remaining));
      size += chunk.length;
      if (size > MAX_CONTENT_BYTES) { truncated = true; await reader.cancel(); break; }
    }
    const body = Buffer.concat(chunks);
    const check = scrubber.checkRequestBody(body, type);
    if (!check.ok) return { value: '[omitted: credential-shaped request content]', truncated: false, contentType: type };
    const text = boundedText(body);
    return { value: text.value, truncated: truncated || text.truncated, contentType: type };
  } catch { return { value: '[unavailable]', truncated: false, contentType: type }; }
}
function captureResponseContent(result) {
  if (result?.jsonBody !== undefined) return boundedText(JSON.stringify(result.jsonBody));
  if (result?.body !== undefined) return boundedText(result.body);
  return { value: '', truncated: false };
}
async function getClient() {
  if (!ENDPOINT) return null;
  if (!client) client = new TableClient(ENDPOINT, TABLE_NAME, new DefaultAzureCredential());
  return client;
}
async function recordCall({ request, requestContent: capturedRequestContent, result, startedAt, callerOid, callerAzp, role, route }) {
  const table = await getClient();
  if (!table) return;
  try {
    await table.createTable().catch(() => undefined);
    const requestContent = await (capturedRequestContent || captureRequestContent(request));
    const responseContent = captureResponseContent(result);
    const at = new Date().toISOString();
    await table.createEntity({
      partitionKey: 'broker-call', rowKey: `${at}-${crypto.randomUUID()}`,
      at, action: 'broker.api.call', outcome: String(result?.status || 500),
      method: request.method, route: String(route || '').slice(0, 512),
      callerOid: String(callerOid || '').slice(0, 256), callerAzp: String(callerAzp || '').slice(0, 256), role: String(role || '').slice(0, 256),
      durationMs: String(Math.max(0, Date.now() - startedAt)),
      requestContent: requestContent.value, requestContentType: requestContent.contentType.slice(0, 256), requestTruncated: requestContent.truncated,
      responseContent: responseContent.value, responseTruncated: responseContent.truncated,
    });
  } catch { /* Audit delivery must never make the broker unavailable. */ }
}

module.exports = { recordCall, captureRequestContent };
