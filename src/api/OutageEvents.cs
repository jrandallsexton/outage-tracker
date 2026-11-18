namespace OutageTracker.Api;

/// <summary>One stored report, reduced to what the outage grouping needs.</summary>
public sealed record ReportPoint(DateTimeOffset StartedAt, DateTimeOffset? EndedAt, string HomeKey);

/// <summary>
/// A neighborhood outage: overlapping or back-to-back reports from one or more homes.
/// End is the latest reported restore time; null when nobody has reported it back yet.
/// </summary>
public sealed record OutageEvent(DateTimeOffset Start, DateTimeOffset? End, bool Ongoing, int Homes, int Reports);

public static class OutageEvents
{
    /// <summary>Reports starting within this long after the group's latest known time join that group.</summary>
    public static readonly TimeSpan JoinGap = TimeSpan.FromMinutes(45);

    /// <summary>A report still open after this long is treated as abandoned, not as an ongoing outage.</summary>
    public static readonly TimeSpan OngoingWindow = TimeSpan.FromHours(12);

    public static IReadOnlyList<OutageEvent> Group(IEnumerable<ReportPoint> reports, DateTimeOffset now)
    {
        var events = new List<OutageEvent>();
        List<ReportPoint>? current = null;
        DateTimeOffset latest = default;

        foreach (var r in reports.OrderBy(r => r.StartedAt))
        {
            if (current is not null && r.StartedAt > latest + JoinGap)
            {
                events.Add(Summarize(current, now));
                current = null;
            }
            if (current is null) { current = []; latest = r.StartedAt; }
            current.Add(r);
            var reportLatest = r.EndedAt ?? r.StartedAt;
            if (reportLatest > latest) latest = reportLatest;
        }
        if (current is not null) events.Add(Summarize(current, now));
        return events;
    }

    private static OutageEvent Summarize(List<ReportPoint> group, DateTimeOffset now)
    {
        var ongoing = group.Any(r => r.EndedAt is null && now - r.StartedAt <= OngoingWindow);
        var ends = group.Where(r => r.EndedAt is not null).Select(r => r.EndedAt!.Value).ToList();
        DateTimeOffset? end = ongoing || ends.Count == 0 ? null : ends.Max();
        return new OutageEvent(
            Start: group.Min(r => r.StartedAt),
            End: end,
            Ongoing: ongoing,
            Homes: group.Select(r => r.HomeKey).Distinct(StringComparer.OrdinalIgnoreCase).Count(),
            Reports: group.Count);
    }

    /// <summary>Same home typed slightly differently still counts once.</summary>
    public static string HomeKey(string? addressId, string addressText) =>
        addressId ?? "custom:" + string.Join(' ', addressText.ToLowerInvariant()
            .Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
}
