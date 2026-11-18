using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;

namespace OutageTracker.Api;

/// <summary>Checks the shared neighborhood code (writes) and the Static Web Apps login role (admin pages).</summary>
public sealed class NeighborhoodGate(IConfiguration config)
{
    public const string CodeHeader = "X-Neighborhood-Code";

    public bool HasValidCode(HttpRequest req) => IsValidCode(req.Headers[CodeHeader].ToString());

    public bool IsValidCode(string? candidate)
    {
        var expected = config["NEIGHBORHOOD_CODE"];
        if (string.IsNullOrWhiteSpace(expected)) return false; // fail closed if not configured
        var a = Encoding.UTF8.GetBytes(Normalize(candidate));
        var b = Encoding.UTF8.GetBytes(Normalize(expected));
        return CryptographicOperations.FixedTimeEquals(a, b);
    }

    /// <summary>Codes are forgiving: case, spaces and dashes don't matter ("Entrada 2026" = "entrada-2026").</summary>
    public static string Normalize(string? code) =>
        new string((code ?? "").Where(char.IsLetterOrDigit).Select(char.ToUpperInvariant).ToArray());

    /// <summary>
    /// Static Web Apps passes the signed-in user as base64 JSON in x-ms-client-principal.
    /// staticwebapp.config.json already limits /api/admin/* to the admin role; this is a second check.
    /// </summary>
    public static bool IsAdmin(HttpRequest req)
    {
        var header = req.Headers["x-ms-client-principal"].ToString();
        if (string.IsNullOrEmpty(header)) return false;
        try
        {
            using var doc = JsonDocument.Parse(Convert.FromBase64String(header));
            return doc.RootElement.TryGetProperty("userRoles", out var roles)
                && roles.EnumerateArray().Any(r => r.GetString() == "admin");
        }
        catch (Exception e) when (e is FormatException or JsonException) { return false; }
    }
}
