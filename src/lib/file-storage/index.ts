import "server-only";
import type { FileStorage } from "./file-storage.interface";
import { createS3FileStorage } from "./s3-file-storage";
import { createVercelBlobStorage } from "./vercel-blob-storage";
import logger from "logger";
import { IS_DEV } from "lib/const";

export type FileStorageDriver = "vercel-blob" | "s3";

const resolveDriver = (): FileStorageDriver => {
  const candidate =
    process.env.STORAGE_TYPE ?? process.env.FILE_STORAGE_TYPE ?? "";

  const normalized = candidate.trim().toLowerCase();
  if (
    normalized === "vercel" ||
    normalized === "vercel-blob" ||
    normalized === "vercel_blob" ||
    normalized === "blob"
  ) {
    return "vercel-blob";
  }

  if (normalized === "s3") {
    return "s3";
  }

  // Default to Vercel Blob
  if (candidate) {
    logger.warn(
      `Unknown STORAGE_TYPE value "${candidate}", falling back to vercel-blob.`,
    );
  }
  return "vercel-blob";
};

declare global {
  // eslint-disable-next-line no-var
  var __server__file_storage__:
    | {
        driver: FileStorageDriver;
        instance: FileStorage;
      }
    | undefined;
}

const storageDriver = resolveDriver();

const createFileStorage = (): FileStorage => {
  logger.info(`Creating file storage: ${storageDriver}`);
  switch (storageDriver) {
    case "vercel-blob":
      return createVercelBlobStorage();
    case "s3":
      return createS3FileStorage();
    default: {
      const exhaustiveCheck: never = storageDriver;
      throw new Error(`Unsupported file storage driver: ${exhaustiveCheck}`);
    }
  }
};

const serverFileStorage =
  globalThis.__server__file_storage__?.driver === storageDriver
    ? globalThis.__server__file_storage__!.instance
    : createFileStorage();

if (IS_DEV) {
  globalThis.__server__file_storage__ = {
    driver: storageDriver,
    instance: serverFileStorage,
  };
}

export { serverFileStorage, storageDriver };
