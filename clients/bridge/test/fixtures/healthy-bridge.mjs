import http from 'node:http';

const port = Number(process.env.TEST_BRIDGE_PORT);
const server = http.createServer((request, response) => {
  if (request.url === '/_bridge/health' && process.env.TEST_BRIDGE_HEALTHY !== 'false') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
    return;
  }
  response.writeHead(404);
  response.end();
});

server.listen(port, '127.0.0.1');
