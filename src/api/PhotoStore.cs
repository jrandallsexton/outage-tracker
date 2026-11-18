using Azure.Storage.Blobs;
using Azure.Storage.Sas;
using Microsoft.Extensions.Configuration;

namespace OutageTracker.Api;

/// <summary>
/// Photos go straight from the phone to Blob Storage using short-lived upload links (SAS),
/// so large uploads never pass through the API. The container is private; admins get short-lived read links.
/// </summary>
public sealed class PhotoStore(IConfiguration config)
{
    public const string ContainerName = "photos";
    private BlobContainerClient? _container;

    private BlobContainerClient Container => _container ??= new BlobContainerClient(
        config["STORAGE_CONNECTION_STRING"]
            ?? throw new InvalidOperationException("STORAGE_CONNECTION_STRING is not configured."),
        ContainerName);

    public static string BlobName(Guid reportId, Guid photoId) => $"{reportId:N}/{photoId:N}.jpg";

    public Uri UploadUri(string blobName) =>
        Container.GetBlobClient(blobName).GenerateSasUri(
            BlobSasPermissions.Create | BlobSasPermissions.Write, DateTimeOffset.UtcNow.AddMinutes(30));

    public Uri ReadUri(string blobName) =>
        Container.GetBlobClient(blobName).GenerateSasUri(BlobSasPermissions.Read, DateTimeOffset.UtcNow.AddHours(2));
}
