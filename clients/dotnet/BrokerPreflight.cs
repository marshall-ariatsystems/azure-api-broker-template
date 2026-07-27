namespace KeyBroker.Client;

/// <summary>Validates broker settings and exposes a minimal authenticated-preflight result.</summary>
public sealed class BrokerPreflight
{
    public static (string Base, string Scope) LoadConfig(IDictionary<string, string?>? env = null)
    {
        var baseUrl = Required(env, "BROKER_BASE");
        var scope = Required(env, "BROKER_SCOPE");

        if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out var parsed) || parsed.Scheme != Uri.UriSchemeHttps ||
            string.IsNullOrEmpty(parsed.Host) || !string.IsNullOrEmpty(parsed.UserInfo) ||
            !string.IsNullOrEmpty(parsed.Query) || !string.IsNullOrEmpty(parsed.Fragment))
            throw new InvalidOperationException("BROKER_BASE must be an HTTPS URL, for example https://<function-app>.azurewebsites.net");
        if (!IsValidScope(scope))
            throw new InvalidOperationException("BROKER_SCOPE is malformed, for example api://<broker-app-id>/.default");

        return (baseUrl.TrimEnd('/'), scope);
    }

    public static async Task<(int Status, string CorrelationId)> RunPreflightAsync(
        Func<CancellationToken, Task<string>> acquireToken,
        Func<string, string, CancellationToken, Task<(int, string)>> invokePreflight,
        string baseUrl,
        CancellationToken ct = default)
    {
        var token = await acquireToken(ct).ConfigureAwait(false);
        var response = await invokePreflight(baseUrl, token, ct).ConfigureAwait(false);
        return (response.Item1, response.Item2);
    }

    private static string Required(IDictionary<string, string?>? env, string name)
    {
        string? value = env is null
            ? Environment.GetEnvironmentVariable(name)
            : env.TryGetValue(name, out var supplied) ? supplied : null;
        if (string.IsNullOrWhiteSpace(value))
            throw new InvalidOperationException($"{name} is required");
        return value.Trim();
    }

    private static bool IsValidScope(string scope)
    {
        if (scope.StartsWith("api://", StringComparison.Ordinal))
        {
            var resource = scope[6..];
            return resource.Length > 0 && resource.Contains('/', StringComparison.Ordinal) && !resource.StartsWith('/');
        }
        return !string.IsNullOrWhiteSpace(scope) && !scope.Any(char.IsWhiteSpace);
    }
}
