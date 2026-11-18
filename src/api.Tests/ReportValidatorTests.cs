using Microsoft.Extensions.Time.Testing;
using OutageTracker.Api;

namespace OutageTracker.Api.Tests;

public class ReportValidatorTests
{
    private static readonly DateTimeOffset Now = new(2026, 11, 18, 14, 0, 0, TimeSpan.Zero);
    private static readonly Guid Device = Guid.NewGuid();
    private readonly ReportValidator _v = new(
        new AddressBook([new Address("3283-baravaldo-cir", 3283, "Baravaldo Cir", "3283 Baravaldo Cir")]),
        new FakeTimeProvider(Now));

    private static ReportInput Input(string? id = "3283-baravaldo-cir", string? text = null,
        DateTimeOffset? start = null, DateTimeOffset? end = null, string? notes = null) =>
        new(Device, id, text, start ?? Now.AddMinutes(-30), end, notes);

    [Fact]
    public void Listed_address_uses_the_official_label()
    {
        var (r, errors) = _v.Validate(Input(id: "3283-BARAVALDO-CIR", text: "ignored"));
        Assert.Empty(errors);
        Assert.Equal("3283-baravaldo-cir", r!.AddressId);
        Assert.Equal("3283 Baravaldo Cir", r.AddressText);
        Assert.True(r.IsListedAddress);
    }

    [Fact]
    public void Typed_in_address_is_accepted_and_tidied()
    {
        var (r, errors) = _v.Validate(Input(id: null, text: "  9999   Somewhere   Ln "));
        Assert.Empty(errors);
        Assert.Null(r!.AddressId);
        Assert.Equal("9999 Somewhere Ln", r.AddressText);
        Assert.False(r.IsListedAddress);
    }

    [Theory]
    [InlineData("no-such-address", null)]
    [InlineData(null, "123")]
    [InlineData(null, null)]
    public void Bad_addresses_are_rejected(string? id, string? text) =>
        Assert.NotEmpty(_v.Validate(Input(id: id, text: text)).Errors);

    [Fact]
    public void Times_must_be_sensible()
    {
        Assert.NotEmpty(_v.Validate(Input(start: Now.AddHours(1))).Errors);                         // future start
        Assert.NotEmpty(_v.Validate(Input(start: Now.AddDays(-400))).Errors);                       // older than a year
        Assert.Empty(_v.Validate(Input(start: Now.AddDays(-200))).Errors);                          // backfill ok
        Assert.NotEmpty(_v.Validate(Input(start: Now.AddHours(-1), end: Now.AddHours(-2))).Errors); // ends before start
        Assert.NotEmpty(_v.Validate(Input(start: Now.AddDays(-20), end: Now)).Errors);              // > 14 days
        Assert.Empty(_v.Validate(Input(start: Now.AddMinutes(5))).Errors);                          // small clock skew ok
        Assert.Empty(_v.Validate(Input(start: Now.AddHours(-3), end: Now.AddHours(-1))).Errors);
    }

    [Fact]
    public void Notes_are_trimmed_and_limited()
    {
        Assert.Null(_v.Validate(Input(notes: "   ")).Report!.Notes);
        Assert.NotEmpty(_v.Validate(Input(notes: new string('x', 501))).Errors);
    }

    [Fact]
    public void Empty_device_is_rejected() =>
        Assert.NotEmpty(_v.Validate(Input() with { DeviceId = Guid.Empty }).Errors);
}
