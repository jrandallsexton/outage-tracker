-- Entrada outage tracker - database schema (Azure SQL Database).
-- Safe to re-run: creates objects only if they don't exist.

IF OBJECT_ID('dbo.Reports', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.Reports (
        -- Generated on the phone, so a report retried from the offline queue is never stored twice.
        Id               uniqueidentifier   NOT NULL CONSTRAINT PK_Reports PRIMARY KEY,
        -- Random id kept on the phone. Only that device can update the report; also used for rate limits.
        DeviceId         uniqueidentifier   NOT NULL,
        -- Id from src/data/addresses.json (e.g. '3283-baravaldo-cir'); NULL for a typed-in address.
        AddressId        varchar(64)        NULL,
        -- Display text: the list label, or exactly what the resident typed.
        AddressText      nvarchar(160)      NOT NULL,
        IsListedAddress  bit                NOT NULL,
        StartedAt        datetimeoffset(0)  NOT NULL,
        -- NULL while the outage is still going ("It's BACK" not tapped yet).
        EndedAt          datetimeoffset(0)  NULL,
        Notes            nvarchar(500)      NULL,
        -- Set when the resident says the report was a mistake; hidden everywhere but kept for the record.
        WithdrawnAt      datetimeoffset(0)  NULL,
        CreatedAt        datetimeoffset(0)  NOT NULL CONSTRAINT DF_Reports_CreatedAt DEFAULT SYSDATETIMEOFFSET(),
        UpdatedAt        datetimeoffset(0)  NOT NULL CONSTRAINT DF_Reports_UpdatedAt DEFAULT SYSDATETIMEOFFSET(),
        CONSTRAINT CK_Reports_EndAfterStart CHECK (EndedAt IS NULL OR EndedAt >= StartedAt)
    );
    CREATE INDEX IX_Reports_StartedAt ON dbo.Reports (StartedAt)
        INCLUDE (EndedAt, AddressId, AddressText, WithdrawnAt);
    CREATE INDEX IX_Reports_Device_CreatedAt ON dbo.Reports (DeviceId, CreatedAt);
END;

IF OBJECT_ID('dbo.Photos', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.Photos (
        Id         uniqueidentifier   NOT NULL CONSTRAINT PK_Photos PRIMARY KEY,  -- generated on the phone
        ReportId   uniqueidentifier   NOT NULL CONSTRAINT FK_Photos_Reports REFERENCES dbo.Reports (Id),
        -- Path inside the 'photos' blob container: {reportId}/{photoId}.jpg
        BlobName   varchar(200)       NOT NULL,
        -- router_light | isp_app | outage_map | other
        Kind       varchar(20)        NOT NULL,
        CreatedAt  datetimeoffset(0)  NOT NULL CONSTRAINT DF_Photos_CreatedAt DEFAULT SYSDATETIMEOFFSET()
    );
    CREATE INDEX IX_Photos_ReportId ON dbo.Photos (ReportId);
END;
