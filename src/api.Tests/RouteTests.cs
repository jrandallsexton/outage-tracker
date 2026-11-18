using System.Reflection;
using Microsoft.Azure.Functions.Worker;
using OutageTracker.Api;

namespace OutageTracker.Api.Tests;

public class RouteTests
{
    private static IEnumerable<string> Routes() =>
        typeof(AddressBook).Assembly.GetTypes()
            .SelectMany(t => t.GetMethods())
            .SelectMany(m => m.GetParameters())
            .Select(p => p.GetCustomAttribute<HttpTriggerAttribute>()?.Route)
            .OfType<string>();

    [Fact]
    public void No_route_starts_with_admin()
    {
        // Azure Functions reserves /api/admin/* for its own host APIs and answers those requests with 404.
        var routes = Routes().ToList();
        Assert.NotEmpty(routes);
        Assert.DoesNotContain(routes, r => r.StartsWith("admin", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void Admin_only_routes_match_the_static_web_apps_rule()
    {
        // staticwebapp.config.json restricts /api/manage/* to the "admin" role.
        var config = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "web", "public", "staticwebapp.config.json"));
        Assert.Contains("\"/api/manage/*\"", config);
        Assert.Contains(Routes(), r => r.StartsWith("manage/"));
    }
}
