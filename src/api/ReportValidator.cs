namespace OutageTracker.Api;

public sealed class ReportValidator(AddressBook addresses, TimeProvider clock)
{
    public const int MinCustomAddressLength = 5;
    public const int MaxAddressLength = 160;
    public const int MaxNotesLength = 500;

    /// <summary>Returns the cleaned-up report, or a list of problems to send back to the phone.</summary>
    public (ValidReport? Report, IReadOnlyList<string> Errors) Validate(ReportInput input)
    {
        var errors = new List<string>();
        var now = clock.GetUtcNow();

        if (input.DeviceId == Guid.Empty) errors.Add("deviceId is required.");

        string? addressId = null;
        string addressText = "";
        bool listed = false;
        if (!string.IsNullOrWhiteSpace(input.AddressId))
        {
            var address = addresses.Find(input.AddressId.Trim());
            if (address is null) errors.Add($"Unknown address id '{input.AddressId}'.");
            else { addressId = address.Id; addressText = address.Label; listed = true; }
        }
        else
        {
            addressText = Collapse(input.AddressText);
            if (addressText.Length < MinCustomAddressLength || addressText.Length > MaxAddressLength)
                errors.Add($"Typed-in address must be {MinCustomAddressLength}-{MaxAddressLength} characters.");
        }

        if (input.StartedAt < now - Limits.MaxReportAge) errors.Add("Outage start is too far in the past.");
        if (input.StartedAt > now + Limits.ClockSkew) errors.Add("Outage start is in the future.");
        if (input.EndedAt is { } end)
        {
            if (end < input.StartedAt) errors.Add("Outage end is before its start.");
            if (end > now + Limits.ClockSkew) errors.Add("Outage end is in the future.");
            if (end - input.StartedAt > Limits.MaxOutageLength) errors.Add("Outage is longer than 14 days.");
        }

        var notes = string.IsNullOrWhiteSpace(input.Notes) ? null : input.Notes.Trim();
        if (notes?.Length > MaxNotesLength) errors.Add($"Notes must be at most {MaxNotesLength} characters.");

        if (errors.Count > 0) return (null, errors);
        return (new ValidReport(input.DeviceId, addressId, addressText, listed,
            input.StartedAt.ToUniversalTime(), input.EndedAt?.ToUniversalTime(), notes, input.Withdrawn), errors);
    }

    private static string Collapse(string? s) =>
        string.Join(' ', (s ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
}
