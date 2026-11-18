using System.Text;
using System.Text.Json;
using Dapper;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Azure.Functions.Worker;

namespace OutageTracker.Api;

/// <summary>Endpoints anyone can call: the public summary, a database wake-up, and the "remember me" cookie.</summary>
public sealed class PublicFunctions(Db db, TimeProvider clock)
{
    public const string RememberCookie = "entrada_home";

    /// <summary>Outage timeline for the neighborhood. Counts only; never addresses or photos.</summary>
    [Function("Summary")]
    public async Task<IActionResult> Summary(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "summary")] HttpRequest req)
    {
        var days = int.TryParse(req.Query["days"], out var d) ? Math.Clamp(d, 1, 90) : 30;
        var now = clock.GetUtcNow();

        await using var conn = await db.OpenAsync();
        var rows = await conn.QueryAsync<(DateTimeOffset StartedAt, DateTimeOffset? EndedAt, string? AddressId, string AddressText)>("""
            SELECT StartedAt, EndedAt, AddressId, AddressText FROM dbo.Reports
            WHERE StartedAt >= @since AND WithdrawnAt IS NULL
            """, new { since = now.AddDays(-days) });

        var events = OutageEvents.Group(
            rows.Select(r => new ReportPoint(r.StartedAt, r.EndedAt, OutageEvents.HomeKey(r.AddressId, r.AddressText))), now);

        // Cache briefly at the edge so a burst of neighbors checking the page doesn't keep the database awake.
        req.HttpContext.Response.Headers.CacheControl = "public, max-age=120";
        return new OkObjectResult(new
        {
            generatedAt = now,
            days,
            totals = new
            {
                outages = events.Count,
                reportedDowntimeHours = Math.Round(events.Where(e => e.End is not null)
                    .Sum(e => (e.End!.Value - e.Start).TotalHours), 1),
                largestOutageHomes = events.Count == 0 ? 0 : events.Max(e => e.Homes),
            },
            events = events.OrderByDescending(e => e.Start),
        });
    }

    /// <summary>Called when the app opens, so a paused database starts waking before the resident taps anything.</summary>
    [Function("Ping")]
    public async Task<IActionResult> Ping(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "ping")] HttpRequest req)
    {
        await using var conn = await db.OpenAsync();
        await conn.ExecuteScalarAsync<int>("SELECT 1");
        return new NoContentResult();
    }

    /// <summary>
    /// Saves the resident's address, code and device id in a cookie set by the server.
    /// iPhone Safari can wipe storage set by page scripts after 7 days without a visit; a cookie the server
    /// sets is not subject to that limit, so the phone can restore the address from it.
    /// </summary>
    [Function("Remember")]
    public async Task<IActionResult> Remember(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "remember")] HttpRequest req)
    {
        using var body = await JsonDocument.ParseAsync(req.Body);
        var json = body.RootElement.GetRawText();
        if (json.Length > 1500) return new BadRequestObjectResult(new { error = "too_large" });

        var value = Convert.ToBase64String(Encoding.UTF8.GetBytes(json)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        req.HttpContext.Response.Cookies.Append(RememberCookie, value, new CookieOptions
        {
            Path = "/",
            MaxAge = TimeSpan.FromDays(400), // the longest browsers allow
            Secure = true,
            SameSite = SameSiteMode.Lax,
            HttpOnly = false, // the app reads it back
        });
        return new NoContentResult();
    }
}
