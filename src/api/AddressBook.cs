using System.Reflection;
using System.Text.Json;

namespace OutageTracker.Api;

public sealed record Address(string Id, int Number, string Street, string Label);

/// <summary>The neighborhood's valid addresses (src/data/addresses.json, embedded at build time).</summary>
public sealed class AddressBook
{
    private readonly Dictionary<string, Address> _byId;

    public AddressBook(IEnumerable<Address> addresses) =>
        _byId = addresses.ToDictionary(a => a.Id, StringComparer.OrdinalIgnoreCase);

    public int Count => _byId.Count;

    public Address? Find(string? id) => id is not null && _byId.TryGetValue(id, out var a) ? a : null;

    public static AddressBook LoadEmbedded()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("addresses.json")
            ?? throw new InvalidOperationException("addresses.json is not embedded in the API assembly.");
        var list = JsonSerializer.Deserialize<List<Address>>(stream, JsonSerializerOptions.Web)
            ?? throw new InvalidOperationException("addresses.json is empty.");
        return new AddressBook(list);
    }
}
