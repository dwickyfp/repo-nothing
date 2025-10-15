import { BASE_URL } from "lib/const";

export const STORAGE_PROXY_ROUTE = "/api/storage/files";

const joinEncodedSegments = (segments: string[]) =>
  segments.map((segment) => encodeURIComponent(segment)).join("/");

const decodeSegments = (segments: string[]) =>
  segments.map((segment) => decodeURIComponent(segment)).join("/");

interface BuildStorageProxyOptions {
  absolute?: boolean;
}

export const buildStorageProxyUrl = (
  key: string,
  options: BuildStorageProxyOptions = {},
): string => {
  const cleaned = key.replace(/^\/+/, "");
  if (!cleaned) {
    const path = `${STORAGE_PROXY_ROUTE}/`;
    return options.absolute ? `${BASE_URL}${path}` : path;
  }
  const segments = cleaned.split("/");
  const path = `${STORAGE_PROXY_ROUTE}/${joinEncodedSegments(segments)}`;
  return options.absolute ? `${BASE_URL}${path}` : path;
};

export const decodeStorageKeyFromParams = (
  params: string[] | string,
): string => {
  if (Array.isArray(params)) {
    return decodeSegments(params);
  }
  return decodeURIComponent(params);
};

const getBucketNames = () => {
  const candidates = [
    process.env.FILE_STORAGE_S3_BUCKET,
    process.env.S3_BUCKET,
    process.env.MINIO_BUCKET,
  ];
  return candidates.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
};

const stripBucketFromPath = (pathname: string) => {
  const buckets = getBucketNames();
  for (const bucket of buckets) {
    const withSlash = `/${bucket}/`;
    if (pathname.startsWith(withSlash)) {
      return pathname.slice(withSlash.length);
    }
  }
  return pathname.replace(/^\/+/, "");
};

export const extractStorageKeyFromUrl = (url: string): string | null => {
  if (!url || url.startsWith("data:")) {
    return null;
  }

  let pathname = url;
  try {
    const parsed = new URL(url, "http://localhost");
    pathname = parsed.pathname;
  } catch {
    // Treat as relative path
    const queryIndex = pathname.indexOf("?");
    if (queryIndex >= 0) {
      pathname = pathname.slice(0, queryIndex);
    }
  }

  if (pathname.startsWith(STORAGE_PROXY_ROUTE)) {
    const raw = pathname.slice(STORAGE_PROXY_ROUTE.length).replace(/^\/+/, "");
    if (!raw) {
      return null;
    }
    return decodeSegments(raw.split("/"));
  }

  const stripped = stripBucketFromPath(pathname);
  if (stripped) {
    return decodeSegments(stripped.split("/"));
  }

  const uploadsIndex = pathname.indexOf("uploads/");
  if (uploadsIndex >= 0) {
    const raw = pathname.slice(uploadsIndex);
    return decodeSegments(raw.split("/"));
  }

  return null;
};
