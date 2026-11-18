using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Configuration;

namespace OutageTracker.Api;

/// <summary>
/// Opens SQL connections. The free-offer database pauses when idle and can take up to a minute to wake;
/// the retry logic rides that out where it can, and the phone's offline queue retries anything that still fails.
/// </summary>
public sealed class Db(IConfiguration config)
{
    private static readonly SqlRetryLogicBaseProvider Retry = SqlConfigurableRetryFactory.CreateExponentialRetryProvider(
        new SqlRetryLogicOption
        {
            NumberOfTries = 4,
            DeltaTime = TimeSpan.FromSeconds(3),
            MaxTimeInterval = TimeSpan.FromSeconds(10),
        });

    public async Task<SqlConnection> OpenAsync(CancellationToken ct = default)
    {
        var cs = config["SQL_CONNECTION_STRING"]
            ?? throw new InvalidOperationException("SQL_CONNECTION_STRING is not configured.");
        var conn = new SqlConnection(cs) { RetryLogicProvider = Retry };
        await conn.OpenAsync(ct);
        return conn;
    }
}
