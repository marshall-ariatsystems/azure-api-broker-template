// Program.cs — vendor API client with NO vendor credentials (C# twin of clients/node/ninja-client.mjs).
//
// The caller proves WHO IT IS to Entra (DefaultAzureCredential: `az login` for devs, or
// AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET for a service principal with a direct
// broker app-role assignment). The broker holds the vendor credential in Key Vault and does any
// OAuth exchange server-side — the credential and vendor token never reach this process.
//
// Configuration (both required):
//   BROKER_BASE   e.g. https://<function-app>.azurewebsites.net/api/broker
//   BROKER_SCOPE  e.g. api://<broker-client-id>/.default
//
// Library use:
//   var broker = new NinjaBrokerClient();
//   string orgs = await broker.CallAsync("/v2/organizations");
//   await broker.CallAsync("/v2/webhook", HttpMethod.Put, "{ ... }");
// CLI use:
//   dotnet run -- /v2/organizations
//   dotnet run -- /v2/webhook PUT "{ \"url\": \"...\" }"

using System.Net.Http.Headers;
using Azure.Core;
using Azure.Identity;

namespace KeyBroker.Client;

public sealed class NinjaBrokerClient
{
    private readonly string _brokerBase;
    private readonly string _brokerScope;
    private readonly HttpClient _http;
    private readonly TokenCredential _credential = new DefaultAzureCredential();
    private AccessToken _cached;

    /// <summary>Create a client using the shared, HTTPS-only broker configuration validator.</summary>
    public NinjaBrokerClient(HttpClient? httpClient = null, IDictionary<string, string?>? env = null)
    {
        var config = BrokerPreflight.LoadConfig(env);
        _brokerBase = config.Base;
        _brokerScope = config.Scope;
        _http = httpClient ?? new HttpClient();
    }

    private async Task<string> GetEntraTokenAsync(CancellationToken ct)
    {
        // Reuse until 2 min before expiry.
        if (_cached.Token is not null && _cached.ExpiresOn > DateTimeOffset.UtcNow.AddMinutes(2))
            return _cached.Token;
        _cached = await _credential.GetTokenAsync(
            new TokenRequestContext(new[] { _brokerScope }), ct);
        return _cached.Token;
    }

    /// <summary>Call a vendor API path through the broker. Returns the response body.</summary>
    public async Task<string> CallAsync(
        string path, HttpMethod? method = null, string? jsonBody = null, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(path)) throw new ArgumentException("path is required", nameof(path));
        var requestMethod = method ?? HttpMethod.Get;
        var uri = $"{_brokerBase}{(path.StartsWith('/') ? path : "/" + path)}";
        HttpResponseMessage? resp = null;
        for (var attempt = 0; attempt <= 2; attempt++)
        {
            using var req = new HttpRequestMessage(requestMethod, uri);
            // Authentication is client-owned; callers cannot provide or override this header.
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await GetEntraTokenAsync(ct));
            req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
            if (jsonBody is not null)
                req.Content = new StringContent(jsonBody, System.Text.Encoding.UTF8, "application/json");
            resp = await _http.SendAsync(req, ct);
            if (resp.StatusCode != System.Net.HttpStatusCode.TooManyRequests ||
                (requestMethod != HttpMethod.Get && requestMethod != HttpMethod.Head) || attempt == 2)
                break;
            var retryAfter = resp.Headers.RetryAfter?.Delta?.TotalMilliseconds ?? 1000;
            var boundedJitter = Random.Shared.Next(0, 251);
            resp.Dispose();
            await Task.Delay(TimeSpan.FromMilliseconds(Math.Max(0, retryAfter) + boundedJitter), ct);
        }
        using var finalResponse = resp ?? throw new InvalidOperationException("broker did not return a response");
        var body = await finalResponse.Content.ReadAsStringAsync(ct);
        if (!finalResponse.IsSuccessStatusCode)
            throw new HttpRequestException($"broker {(int)finalResponse.StatusCode} for {path}: {body}");
        return body;
    }

    /// <summary>Call the authenticated, no-side-effect authorization preflight endpoint.</summary>
    public async Task<(int Status, string? CorrelationId)> PreflightAsync(string routeSlug, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(routeSlug) || !routeSlug.All(c => char.IsLower(c) || char.IsDigit(c) || c == '-'))
            throw new ArgumentException("routeSlug must be a lowercase route slug", nameof(routeSlug));
        using var req = new HttpRequestMessage(HttpMethod.Get, $"{_brokerBase}/preflight/{routeSlug}");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await GetEntraTokenAsync(ct));
        using var response = await _http.SendAsync(req, ct);
        return ((int)response.StatusCode, response.Headers.TryGetValues("x-correlation-id", out var values) ? values.FirstOrDefault() : null);
    }

    public static async Task<int> Main(string[] args)
    {
        if (args.Length == 0)
        {
            Console.Error.WriteLine("usage: dotnet run -- <path> [method] [json-body]");
            return 2;
        }
        try
        {
            var client = new NinjaBrokerClient();
            var method = args.Length > 1 ? new HttpMethod(args[1].ToUpperInvariant()) : HttpMethod.Get;
            var body = args.Length > 2 ? args[2] : null;
            Console.WriteLine(await client.CallAsync(args[0], method, body));
            return 0;
        }
        // Intentional top-level CLI guard: turn any failure into a clean message + nonzero exit code.
        catch (Exception e)
        {
            Console.Error.WriteLine(e.Message);
            return 1;
        }
    }
}
