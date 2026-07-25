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
    // Broker base + scope from BROKER_BASE / BROKER_SCOPE env vars (both required).
    private static readonly string BrokerBase =
        (Environment.GetEnvironmentVariable("BROKER_BASE")
         ?? throw new InvalidOperationException(
             "BROKER_BASE env var is required, e.g. https://<function-app>.azurewebsites.net/api/broker")).TrimEnd('/');
    private static readonly string BrokerScope =
        Environment.GetEnvironmentVariable("BROKER_SCOPE")
        ?? throw new InvalidOperationException(
            "BROKER_SCOPE env var is required, e.g. api://<broker-client-id>/.default");

    private static readonly HttpClient Http = new();
    private readonly TokenCredential _credential = new DefaultAzureCredential();
    private AccessToken _cached;

    private async Task<string> GetEntraTokenAsync(CancellationToken ct)
    {
        // Reuse until 2 min before expiry.
        if (_cached.Token is not null && _cached.ExpiresOn > DateTimeOffset.UtcNow.AddMinutes(2))
            return _cached.Token;
        _cached = await _credential.GetTokenAsync(
            new TokenRequestContext(new[] { BrokerScope }), ct);
        return _cached.Token;
    }

    /// <summary>Call a vendor API path through the broker. Returns the response body.</summary>
    public async Task<string> CallAsync(
        string path, HttpMethod? method = null, string? jsonBody = null, CancellationToken ct = default)
    {
        var uri = $"{BrokerBase}{(path.StartsWith('/') ? path : "/" + path)}";
        using var req = new HttpRequestMessage(method ?? HttpMethod.Get, uri);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await GetEntraTokenAsync(ct));
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (jsonBody is not null)
            req.Content = new StringContent(jsonBody, System.Text.Encoding.UTF8, "application/json");

        using var resp = await Http.SendAsync(req, ct);
        var body = await resp.Content.ReadAsStringAsync(ct);
        if (!resp.IsSuccessStatusCode)
            throw new HttpRequestException($"broker {(int)resp.StatusCode} for {path}: {body}");
        return body;
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
