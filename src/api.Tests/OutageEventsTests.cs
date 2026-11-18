using OutageTracker.Api;

namespace OutageTracker.Api.Tests;

public class OutageEventsTests
{
    private static readonly DateTimeOffset T0 = new(2026, 11, 18, 8, 0, 0, TimeSpan.Zero);
    private static ReportPoint R(int startMin, int? endMin, string home) =>
        new(T0.AddMinutes(startMin), endMin is null ? null : T0.AddMinutes(endMin.Value), home);

    [Fact]
    public void Neighbors_reporting_the_same_outage_form_one_event()
    {
        var events = OutageEvents.Group([R(0, 60, "a"), R(5, 55, "b"), R(20, null, "c"), R(10, 62, "a")], now: T0.AddDays(2));
        var e = Assert.Single(events);
        Assert.Equal(T0, e.Start);
        Assert.Equal(T0.AddMinutes(62), e.End);
        Assert.Equal(3, e.Homes);   // home "a" reported twice
        Assert.Equal(4, e.Reports);
        Assert.False(e.Ongoing);    // c's open report is older than 12 hours: abandoned, not ongoing
    }

    [Fact]
    public void Separate_outages_stay_separate()
    {
        var events = OutageEvents.Group([R(0, 30, "a"), R(30 + 46, 120, "b")], now: T0.AddDays(1));
        Assert.Equal(2, events.Count);
    }

    [Fact]
    public void Report_arriving_within_the_gap_after_the_last_restore_joins()
    {
        var events = OutageEvents.Group([R(0, 30, "a"), R(30 + 44, null, "b")], now: T0.AddDays(1));
        Assert.Single(events);
    }

    [Fact]
    public void Recent_open_report_makes_the_event_ongoing_with_no_end()
    {
        var events = OutageEvents.Group([R(0, 20, "a"), R(10, null, "b")], now: T0.AddHours(1));
        var e = Assert.Single(events);
        Assert.True(e.Ongoing);
        Assert.Null(e.End);
    }

    [Fact]
    public void Empty_input_gives_no_events() => Assert.Empty(OutageEvents.Group([], T0));

    [Fact]
    public void Typed_in_addresses_match_regardless_of_case_and_spacing() =>
        Assert.Equal(OutageEvents.HomeKey(null, "123  Main St"), OutageEvents.HomeKey(null, "123 main st"));
}
