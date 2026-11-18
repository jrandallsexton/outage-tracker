using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using OutageTracker.Api;

namespace OutageTracker.Api.Tests;

public class GateAndAddressTests
{
    private static NeighborhoodGate Gate(string? code) => new(new ConfigurationBuilder()
        .AddInMemoryCollection(new Dictionary<string, string?> { ["NEIGHBORHOOD_CODE"] = code }).Build());

    [Theory]
    [InlineData("entrada-2026")]
    [InlineData("ENTRADA 2026")]
    [InlineData(" Entrada2026 ")]
    public void Code_ignores_case_spaces_and_dashes(string typed) => Assert.True(Gate("Entrada 2026").IsValidCode(typed));

    [Fact]
    public void Wrong_or_missing_code_fails()
    {
        Assert.False(Gate("Entrada 2026").IsValidCode("Entrada 2025"));
        Assert.False(Gate("Entrada 2026").IsValidCode(null));
        Assert.False(Gate(null).IsValidCode("anything"));   // not configured: fail closed
        Assert.False(Gate("").IsValidCode(""));
    }

    [Fact]
    public void Admin_role_is_read_from_the_static_web_apps_header()
    {
        static HttpRequest Req(string? json)
        {
            var ctx = new DefaultHttpContext();
            if (json is not null) ctx.Request.Headers["x-ms-client-principal"] = Convert.ToBase64String(Encoding.UTF8.GetBytes(json));
            return ctx.Request;
        }
        Assert.True(NeighborhoodGate.IsAdmin(Req("""{"userRoles":["anonymous","authenticated","admin"]}""")));
        Assert.False(NeighborhoodGate.IsAdmin(Req("""{"userRoles":["anonymous","authenticated"]}""")));
        Assert.False(NeighborhoodGate.IsAdmin(Req(null)));
        var junk = new DefaultHttpContext();
        junk.Request.Headers["x-ms-client-principal"] = "not base64!";
        Assert.False(NeighborhoodGate.IsAdmin(junk.Request));
    }

    [Fact]
    public void Embedded_address_list_loads()
    {
        var book = AddressBook.LoadEmbedded();
        Assert.True(book.Count > 700);
        Assert.Equal("3283 Baravaldo Cir", book.Find("3283-baravaldo-cir")!.Label);
    }
}
