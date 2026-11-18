namespace OutageTracker.Api;

/// <summary>Body of PUT /api/reports/{id}. The phone always sends the full current state of the report.</summary>
public sealed record ReportInput(
    Guid DeviceId,
    string? AddressId,
    string? AddressText,
    DateTimeOffset StartedAt,
    DateTimeOffset? EndedAt,
    string? Notes,
    bool Withdrawn = false);

/// <summary>A report after validation, ready to store.</summary>
public sealed record ValidReport(
    Guid DeviceId,
    string? AddressId,
    string AddressText,
    bool IsListedAddress,
    DateTimeOffset StartedAt,
    DateTimeOffset? EndedAt,
    string? Notes,
    bool Withdrawn);

/// <summary>Body of PUT /api/reports/{id}/photos/{photoId}.</summary>
public sealed record PhotoInput(Guid DeviceId, string? Kind);

public static class PhotoKinds
{
    public static readonly IReadOnlySet<string> All =
        new HashSet<string>(["router_light", "isp_app", "outage_map", "other"]);
}

public static class Limits
{
    public const int MaxNewReportsPerDevicePerDay = 20;
    public const int MaxPhotosPerReport = 6;
    public static readonly TimeSpan MaxReportAge = TimeSpan.FromDays(31);
    public static readonly TimeSpan MaxOutageLength = TimeSpan.FromDays(14);
    /// <summary>Allowance for phones whose clocks run a little fast.</summary>
    public static readonly TimeSpan ClockSkew = TimeSpan.FromMinutes(10);
}
