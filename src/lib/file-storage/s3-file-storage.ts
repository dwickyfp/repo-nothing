import path from "node:path";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
  type HeadObjectCommandOutput,
  type ObjectCannedACL,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import logger from "logger";
import { FileNotFoundError } from "lib/errors";
import type {
  FileMetadata,
  FileStorage,
  UploadOptions,
  UploadUrlOptions,
} from "./file-storage.interface";
import {
  getContentTypeFromFilename,
  resolveStoragePrefix,
  sanitizeFilename,
  toBuffer,
} from "./storage-utils";
import { generateUUID } from "lib/utils";

interface S3DriverConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  publicBaseUrl?: string;
  forcePathStyle: boolean;
  uploadAcl?: ObjectCannedACL;
  downloadUrlTtlSeconds: number;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
  };
}

const STORAGE_PREFIX = resolveStoragePrefix();
const DEFAULT_UPLOAD_URL_TTL = 3600; // 1 hour
const DEFAULT_DOWNLOAD_URL_TTL = 900; // 15 minutes

const truthy = (value?: string | null) =>
  value
    ? ["1", "true", "yes", "on"].includes(value.trim().toLowerCase())
    : false;

const parsePositiveInt = (value?: string | null, fallback?: number) => {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
};

const resolveAcl = (value?: string | null): ObjectCannedACL | undefined => {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();

  switch (normalized) {
    case "private":
    case "public-read":
    case "public-read-write":
    case "authenticated-read":
    case "aws-exec-read":
    case "bucket-owner-read":
    case "bucket-owner-full-control":
      return normalized as ObjectCannedACL;
    default:
      return undefined;
  }
};

const streamToBuffer = async (
  body: GetObjectCommandOutput["Body"],
): Promise<Buffer> => {
  if (!body) {
    return Buffer.alloc(0);
  }

  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  if (typeof (body as any).transformToByteArray === "function") {
    const array = await (body as any).transformToByteArray();
    return Buffer.from(array);
  }

  if (body instanceof Blob) {
    const arrayBuffer = await body.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  throw new Error("Unsupported S3 response body type");
};

const isNotFoundError = (error: unknown) => {
  if (!error || typeof error !== "object") {
    return false;
  }
  const err = error as {
    $metadata?: { httpStatusCode?: number };
    name?: string;
    Code?: string;
    code?: string;
  };

  if (err.$metadata?.httpStatusCode === 404) {
    return true;
  }

  const code = err.Code ?? err.code;
  return (
    code === "NoSuchKey" ||
    code === "NotFound" ||
    err.name === "NoSuchKey" ||
    err.name === "NotFound"
  );
};

const buildObjectKey = (filename: string) => {
  const safe = sanitizeFilename(filename || "file");
  const id = generateUUID();
  const prefix = STORAGE_PREFIX ? `${STORAGE_PREFIX}/` : "";
  return path.posix.join(prefix, `${id}-${safe}`);
};

const loadConfig = (): S3DriverConfig => {
  const bucket =
    process.env.FILE_STORAGE_S3_BUCKET ??
    process.env.S3_BUCKET ??
    process.env.MINIO_BUCKET;

  if (!bucket) {
    throw new Error(
      "Missing S3 bucket configuration. Set FILE_STORAGE_S3_BUCKET or S3_BUCKET.",
    );
  }

  const region =
    process.env.FILE_STORAGE_S3_REGION ??
    process.env.S3_REGION ??
    process.env.AWS_REGION ??
    "us-east-1";

  const endpoint =
    process.env.FILE_STORAGE_S3_ENDPOINT ??
    process.env.S3_ENDPOINT ??
    process.env.AWS_S3_ENDPOINT;

  const publicBaseUrl =
    process.env.FILE_STORAGE_S3_PUBLIC_URL ?? process.env.S3_PUBLIC_URL;

  const forcePathStyle = truthy(
    process.env.FILE_STORAGE_S3_FORCE_PATH_STYLE ??
      process.env.S3_FORCE_PATH_STYLE ??
      process.env.AWS_S3_FORCE_PATH_STYLE,
  );

  const rawAcl =
    process.env.FILE_STORAGE_S3_ACL ??
    process.env.S3_ACL ??
    process.env.AWS_S3_ACL;
  const uploadAcl = resolveAcl(rawAcl);
  if (rawAcl && !uploadAcl) {
    logger.warn(
      `Unsupported S3 ACL "${rawAcl}". Supported values: private, public-read, public-read-write, authenticated-read, aws-exec-read, bucket-owner-read, bucket-owner-full-control.`,
    );
  }

  const accessKeyId =
    process.env.AWS_ACCESS_KEY_ID ??
    process.env.S3_ACCESS_KEY_ID ??
    process.env.S3_ACCESS_KEY ??
    process.env.MINIO_ROOT_USER ??
    undefined;

  const secretAccessKey =
    process.env.AWS_SECRET_ACCESS_KEY ??
    process.env.S3_SECRET_ACCESS_KEY ??
    process.env.S3_SECRET_KEY ??
    process.env.MINIO_ROOT_PASSWORD ??
    process.env.MINIO_ROOT_PASS ??
    undefined;

  const downloadUrlTtlSeconds =
    parsePositiveInt(
      process.env.FILE_STORAGE_S3_DOWNLOAD_URL_TTL ??
        process.env.S3_DOWNLOAD_URL_TTL,
      DEFAULT_DOWNLOAD_URL_TTL,
    ) ?? DEFAULT_DOWNLOAD_URL_TTL;

  const credentials =
    accessKeyId && secretAccessKey
      ? {
          accessKeyId,
          secretAccessKey,
        }
      : undefined;

  return {
    bucket,
    region,
    endpoint,
    publicBaseUrl,
    forcePathStyle,
    uploadAcl,
    downloadUrlTtlSeconds,
    credentials,
  };
};

const createPublicUrl = (config: S3DriverConfig, key: string) => {
  if (config.publicBaseUrl) {
    const base = config.publicBaseUrl.replace(/\/+$/, "");
    return `${base}/${key}`;
  }

  if (config.endpoint) {
    try {
      const endpointUrl = new URL(config.endpoint);
      if (config.forcePathStyle) {
        return `${endpointUrl.origin}/${config.bucket}/${key}`;
      }
      return `${endpointUrl.protocol}//${config.bucket}.${endpointUrl.host}/${key}`;
    } catch {
      const trimmed = config.endpoint.replace(/\/+$/, "");
      if (config.forcePathStyle) {
        return `${trimmed}/${config.bucket}/${key}`;
      }
      return `${config.bucket}.${trimmed}/${key}`;
    }
  }

  if (config.region === "us-east-1") {
    return `https://${config.bucket}.s3.amazonaws.com/${key}`;
  }

  return `https://${config.bucket}.s3.${config.region}.amazonaws.com/${key}`;
};

const mapMetadata = (
  key: string,
  info: HeadObjectCommandOutput,
): FileMetadata => ({
  key,
  filename: path.posix.basename(key),
  contentType: info.ContentType ?? "application/octet-stream",
  size: Number(info.ContentLength ?? 0),
  uploadedAt: info.LastModified ? new Date(info.LastModified) : undefined,
});

export const createS3FileStorage = (): FileStorage => {
  const config = loadConfig();
  const s3Client = new S3Client({
    region: config.region,
    endpoint: config.endpoint?.replace(/\/+$/, ""),
    forcePathStyle: config.forcePathStyle,
    credentials: config.credentials,
  });

  const s3Logger = logger.withDefaults({
    tag: "file-storage:s3",
  });

  s3Logger.info("Initialized S3 storage driver", {
    bucket: config.bucket,
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    publicBaseUrl: Boolean(config.publicBaseUrl),
  });

  const headObjectOrNull = async (key: string) => {
    try {
      return await s3Client.send(
        new HeadObjectCommand({ Bucket: config.bucket, Key: key }),
      );
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  };

  const hasPublicReadAccess =
    config.uploadAcl === "public-read" ||
    config.uploadAcl === "public-read-write";

  const canUsePublicUrl = hasPublicReadAccess;
  const canUseConfiguredPublicUrl = hasPublicReadAccess && config.publicBaseUrl;

  const resolveReadableUrl = async (key: string) => {
    if (canUseConfiguredPublicUrl) {
      return createPublicUrl(config, key);
    }

    if (hasPublicReadAccess) {
      // Bucket is public but no custom public URL configured
      return createPublicUrl({ ...config, publicBaseUrl: undefined }, key);
    }

    const command = new GetObjectCommand({
      Bucket: config.bucket,
      Key: key,
    });

    return getSignedUrl(s3Client, command, {
      expiresIn: config.downloadUrlTtlSeconds,
    });
  };

  return {
    async upload(content, options: UploadOptions = {}) {
      const buffer = await toBuffer(content);
      const filename = options.filename ?? "file";
      const contentType =
        options.contentType ?? getContentTypeFromFilename(filename);
      const key = buildObjectKey(filename);

      await s3Client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: buffer,
          ContentType: contentType,
          ContentLength: buffer.byteLength,
          ACL: config.uploadAcl,
        }),
      );

      const sourceUrl = await resolveReadableUrl(key);

      const metadata: FileMetadata = {
        key,
        filename: path.posix.basename(key),
        contentType,
        size: buffer.byteLength,
        uploadedAt: new Date(),
      };

      return {
        key,
        sourceUrl,
        metadata,
      };
    },

    async createUploadUrl(options: UploadUrlOptions) {
      const filename = options.filename || "file";
      const contentType =
        options.contentType ?? getContentTypeFromFilename(filename);
      const expiresInSeconds =
        options.expiresInSeconds ?? DEFAULT_UPLOAD_URL_TTL;
      const key = buildObjectKey(filename);

      const command = new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        ContentType: contentType,
        ACL: config.uploadAcl,
      });

      const url = await getSignedUrl(s3Client, command, {
        expiresIn: expiresInSeconds,
      });

      const headers: Record<string, string> = {
        "Content-Type": contentType,
      };

      if (config.uploadAcl) {
        headers["x-amz-acl"] = config.uploadAcl;
      }

      const sourceUrl = await resolveReadableUrl(key);

      return {
        key,
        url,
        method: "PUT",
        expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
        headers,
        sourceUrl,
      };
    },

    async download(key) {
      try {
        const result = await s3Client.send(
          new GetObjectCommand({ Bucket: config.bucket, Key: key }),
        );
        return await streamToBuffer(result.Body);
      } catch (error) {
        if (isNotFoundError(error)) {
          throw new FileNotFoundError(key, error);
        }
        throw error;
      }
    },

    async delete(key) {
      await s3Client.send(
        new DeleteObjectCommand({ Bucket: config.bucket, Key: key }),
      );
    },

    async exists(key) {
      return (await headObjectOrNull(key)) !== null;
    },

    async getMetadata(key) {
      const info = await headObjectOrNull(key);
      if (!info) {
        return null;
      }
      return mapMetadata(key, info);
    },

    async getSourceUrl(key) {
      const info = await headObjectOrNull(key);
      if (!info) {
        return null;
      }
      return resolveReadableUrl(key);
    },

    async getDownloadUrl(key) {
      const info = await headObjectOrNull(key);
      if (!info) {
        return null;
      }

      if (canUsePublicUrl) {
        return createPublicUrl(config, key);
      }

      const command = new GetObjectCommand({
        Bucket: config.bucket,
        Key: key,
      });

      return getSignedUrl(s3Client, command, {
        expiresIn: config.downloadUrlTtlSeconds,
      });
    },
  };
};
