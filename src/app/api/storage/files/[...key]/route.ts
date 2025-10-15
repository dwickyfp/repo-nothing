import { NextResponse } from "next/server";
import { serverFileStorage } from "lib/file-storage";
import { FileNotFoundError } from "lib/errors";
import {
  decodeStorageKeyFromParams,
  STORAGE_PROXY_ROUTE,
} from "lib/file-storage/storage-paths";

const FIVE_MINUTES = 300;

const getKeyFromParams = (params: { key?: string[] }) => {
  const raw = params.key ?? [];
  return decodeStorageKeyFromParams(raw);
};

const buildHeaders = (metadata: {
  contentType?: string | null;
  size?: number | null;
  filename?: string | null;
}) => {
  const headers = new Headers();
  headers.set("Cache-Control", `public, max-age=${FIVE_MINUTES}`);
  headers.set("Access-Control-Allow-Origin", "*");
  if (metadata.contentType) {
    headers.set("Content-Type", metadata.contentType);
  } else {
    headers.set("Content-Type", "application/octet-stream");
  }
  if (typeof metadata.size === "number" && Number.isFinite(metadata.size)) {
    headers.set("Content-Length", `${metadata.size}`);
  }
  if (metadata.filename) {
    headers.set(
      "Content-Disposition",
      `inline; filename=\"${metadata.filename.replace(/\"/g, "")}\"`,
    );
  }
  headers.set("X-Storage-Proxy", STORAGE_PROXY_ROUTE);
  return headers;
};

export async function GET(
  _request: Request,
  context: { params: Promise<{ key?: string[] }> },
) {
  const params = await context.params;
  const key = getKeyFromParams(params);
  if (!key) {
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }

  try {
    const [buffer, metadata] = await Promise.all([
      serverFileStorage.download(key),
      serverFileStorage.getMetadata(key),
    ]);
    const body = new Uint8Array(buffer);

    const headers = buildHeaders({
      contentType: metadata?.contentType,
      size: buffer.byteLength,
      filename: metadata?.filename,
    });

    return new NextResponse(body as unknown as BodyInit, {
      status: 200,
      headers,
    });
  } catch (error) {
    if (error instanceof FileNotFoundError) {
      return NextResponse.json({ error: "Not Found" }, { status: 404 });
    }

    console.error(`Failed to proxy storage object: ${key}`, error);
    return NextResponse.json(
      { error: "Failed to fetch file from storage" },
      { status: 500 },
    );
  }
}

export async function HEAD(
  _request: Request,
  context: { params: Promise<{ key?: string[] }> },
) {
  const params = await context.params;
  const key = getKeyFromParams(params);
  if (!key) {
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }
  try {
    const metadata = await serverFileStorage.getMetadata(key);
    if (!metadata) {
      return NextResponse.json({ error: "Not Found" }, { status: 404 });
    }

    const headers = buildHeaders({
      contentType: metadata.contentType,
      size: metadata.size,
      filename: metadata.filename,
    });

    return new NextResponse(null, {
      status: 200,
      headers,
    });
  } catch (error) {
    if (error instanceof FileNotFoundError) {
      return NextResponse.json({ error: "Not Found" }, { status: 404 });
    }

    console.error(`Failed to fetch storage metadata: ${key}`, error);
    return NextResponse.json(
      { error: "Failed to fetch file metadata" },
      { status: 500 },
    );
  }
}
