using Dapper;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Azure.Functions.Worker;

namespace OutageTracker.Api;

/// <summary>Resident-facing writes. All require the neighborhood code header.</summary>
public sealed class ReportFunctions(NeighborhoodGate gate, ReportValidator validator, Db db, PhotoStore photos, TimeProvider clock)
{
    /// <summary>
    /// Create or update a report. The id comes from the phone, so a retry from the offline queue
    /// just re-applies the same state. Only the device that created a report can change it.
    /// </summary>
    [Function("PutReport")]
    public async Task<IActionResult> PutReport(
        [HttpTrigger(AuthorizationLevel.Anonymous, "put", Route = "reports/{id:guid}")] HttpRequest req, Guid id)
    {
        if (!gate.HasValidCode(req)) return new UnauthorizedObjectResult(new { error = "bad_code" });

        var input = await req.ReadFromJsonAsync<ReportInput>();
        if (input is null) return new BadRequestObjectResult(new { error = "invalid", details = new[] { "Body is required." } });
        var (report, errors) = validator.Validate(input);
        if (report is null) return new BadRequestObjectResult(new { error = "invalid", details = errors });

        await using var conn = await db.OpenAsync();
        var owner = await conn.QuerySingleOrDefaultAsync<Guid?>(
            "SELECT DeviceId FROM dbo.Reports WHERE Id = @id", new { id });

        var p = new
        {
            id, report.DeviceId, report.AddressId, report.AddressText, report.IsListedAddress,
            report.StartedAt, report.EndedAt, report.Notes,
            WithdrawnAt = report.Withdrawn ? clock.GetUtcNow() : (DateTimeOffset?)null,
            since = clock.GetUtcNow().AddDays(-1),
        };

        if (owner is null)
        {
            var recent = await conn.ExecuteScalarAsync<int>(
                "SELECT COUNT(*) FROM dbo.Reports WHERE DeviceId = @DeviceId AND CreatedAt >= @since", p);
            if (recent >= Limits.MaxNewReportsPerDevicePerDay)
                return new ObjectResult(new { error = "rate_limited" }) { StatusCode = StatusCodes.Status429TooManyRequests };

            await conn.ExecuteAsync("""
                INSERT dbo.Reports (Id, DeviceId, AddressId, AddressText, IsListedAddress, StartedAt, EndedAt, Notes, WithdrawnAt)
                VALUES (@id, @DeviceId, @AddressId, @AddressText, @IsListedAddress, @StartedAt, @EndedAt, @Notes, @WithdrawnAt)
                """, p);
        }
        else if (owner != report.DeviceId)
        {
            return new ObjectResult(new { error = "not_owner" }) { StatusCode = StatusCodes.Status403Forbidden };
        }
        else
        {
            // Keep the first withdrawal time if the phone re-sends a withdrawn report.
            await conn.ExecuteAsync("""
                UPDATE dbo.Reports SET
                    AddressId = @AddressId, AddressText = @AddressText, IsListedAddress = @IsListedAddress,
                    StartedAt = @StartedAt, EndedAt = @EndedAt, Notes = @Notes,
                    WithdrawnAt = CASE WHEN @WithdrawnAt IS NULL THEN NULL ELSE COALESCE(WithdrawnAt, @WithdrawnAt) END,
                    UpdatedAt = SYSDATETIMEOFFSET()
                WHERE Id = @id
                """, p);
        }
        return new OkObjectResult(new { id });
    }

    /// <summary>Registers a photo on a report and returns a 30-minute link the phone uploads the JPEG to.</summary>
    [Function("PutPhoto")]
    public async Task<IActionResult> PutPhoto(
        [HttpTrigger(AuthorizationLevel.Anonymous, "put", Route = "reports/{id:guid}/photos/{photoId:guid}")] HttpRequest req,
        Guid id, Guid photoId)
    {
        if (!gate.HasValidCode(req)) return new UnauthorizedObjectResult(new { error = "bad_code" });

        var input = await req.ReadFromJsonAsync<PhotoInput>();
        var kind = input?.Kind ?? "other";
        if (input is null || input.DeviceId == Guid.Empty || !PhotoKinds.All.Contains(kind))
            return new BadRequestObjectResult(new { error = "invalid" });

        await using var conn = await db.OpenAsync();
        var owner = await conn.QuerySingleOrDefaultAsync<Guid?>("SELECT DeviceId FROM dbo.Reports WHERE Id = @id", new { id });
        if (owner is null) return new NotFoundObjectResult(new { error = "no_report" });
        if (owner != input.DeviceId) return new ObjectResult(new { error = "not_owner" }) { StatusCode = StatusCodes.Status403Forbidden };

        var blobName = PhotoStore.BlobName(id, photoId);
        var exists = await conn.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM dbo.Photos WHERE Id = @photoId", new { photoId }) > 0;
        if (!exists)
        {
            var count = await conn.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM dbo.Photos WHERE ReportId = @id", new { id });
            if (count >= Limits.MaxPhotosPerReport) return new BadRequestObjectResult(new { error = "too_many_photos" });
            await conn.ExecuteAsync(
                "INSERT dbo.Photos (Id, ReportId, BlobName, Kind) VALUES (@photoId, @id, @blobName, @kind)",
                new { photoId, id, blobName, kind });
        }
        return new OkObjectResult(new { uploadUrl = photos.UploadUri(blobName) });
    }

    /// <summary>Lets the setup screen tell people right away if they typed the code wrong.</summary>
    [Function("CheckCode")]
    public IActionResult CheckCode(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "check-code")] HttpRequest req) =>
        gate.HasValidCode(req) ? new NoContentResult() : new UnauthorizedObjectResult(new { error = "bad_code" });
}
