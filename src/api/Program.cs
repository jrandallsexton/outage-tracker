using Microsoft.Azure.Functions.Worker.Builder;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using OutageTracker.Api;

var builder = FunctionsApplication.CreateBuilder(args);
builder.ConfigureFunctionsWebApplication();

builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton(AddressBook.LoadEmbedded());
builder.Services.AddSingleton<NeighborhoodGate>();
builder.Services.AddSingleton<Db>();
builder.Services.AddSingleton<PhotoStore>();
builder.Services.AddSingleton<ReportValidator>();

builder.Build().Run();
