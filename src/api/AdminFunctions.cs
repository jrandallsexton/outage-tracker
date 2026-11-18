using Dapper;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Azure.Functions.Worker;

namespace OutageTracker.Api;

/// <summary>Full report details for admins (signed in through Static Web Apps with the "admin" role).</summary>
public sealed class AdminFunctions(Db db, PhotoStore photos, TimeProvider clock)
{
    private sealed record Row(Guid Id, string? AddressId, string AddressText, bool IsListedAddress,
        DateTimeOffset StartedAt, DateTimeOffset? EndedAt, string? Notes, DateTimeOffset? WithdrawnAt, DateTimeOffset CreatedAt);
    private sealed record PhotoRow(Guid Id, Guid ReportId, string BlobName, string Kind);

    [Function("AdminReports")]
    public async Task<IActionResult> Reports(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "admin/reports")] HttpRequest req)
    {
        if (!NeighborhoodGate.IsAdmin(req)) return new UnauthorizedResult();
        var days = int.TryParse(req.Query["days"], out var d) ? Math.Clamp(d, 1, 366) : 60;
        var since = clock.GetUtcNow().AddDays(-days);

        await using var conn = await db.OpenAsync();
        var reports = (await conn.QueryAsync<Row>("""
            SELECT Id, AddressId, AddressText, IsListedAddress, StartedAt, EndedAt, Notes, WithdrawnAt, CreatedAt
            FROM dbo.Reports WHERE StartedAt >= @since ORDER BY StartedAt DESC
            """, new { since })).ToList();
        var photoRows = await conn.QueryAsync<PhotoRow>("""
            SELECT p.Id, p.ReportId, p.BlobName, p.Kind FROM dbo.Photos p
            JOIN dbo.Reports r ON r.Id = p.ReportId WHERE r.StartedAt >= @since
            """, new { since });
        var byReport = photoRows.ToLookup(p => p.ReportId);

        return new OkObjectResult(new
        {
            days,
            reports = reports.Select(r => new
            {
                r.Id, r.AddressId, r.AddressText, r.IsListedAddress, r.StartedAt, r.EndedAt, r.Notes,
                withdrawn = r.WithdrawnAt is not null, r.CreatedAt,
                photos = byReport[r.Id].Select(p => new { p.Id, p.Kind, url = photos.ReadUri(p.BlobName) }),
            }),
        });
    }
}
