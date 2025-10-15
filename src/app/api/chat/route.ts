import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  smoothStream,
  stepCountIs,
  streamText,
  Tool,
  UIMessage,
} from "ai";

import { customModelProvider, isToolCallUnsupportedModel } from "lib/ai/models";

import { mcpClientsManager } from "lib/ai/mcp/mcp-manager";

import { agentRepository, chatRepository } from "lib/db/repository";
import globalLogger from "logger";
import {
  buildMcpServerCustomizationsSystemPrompt,
  buildUserSystemPrompt,
  buildToolCallUnsupportedModelSystemPrompt,
} from "lib/ai/prompts";
import {
  chatApiSchemaRequestBodySchema,
  ChatMention,
  ChatMetadata,
} from "app-types/chat";

import { errorIf, safe } from "ts-safe";

import {
  excludeToolExecution,
  handleError,
  manualToolExecuteByLastMessage,
  mergeSystemPrompt,
  extractInProgressToolPart,
  filterMcpServerCustomizations,
  loadMcpTools,
  loadWorkFlowTools,
  loadAppDefaultTools,
  convertToSavePart,
} from "./shared.chat";
import {
  rememberAgentAction,
  rememberMcpServerCustomizationsAction,
} from "./actions";
import { getSession } from "auth/server";
import { colorize } from "consola/utils";
import { generateUUID } from "lib/utils";
import { nanoBananaTool, openaiImageTool } from "lib/ai/tools/image";
import { ImageToolName } from "lib/ai/tools";
import { serverFileStorage } from "lib/file-storage";
import { extractStorageKeyFromUrl } from "lib/file-storage/storage-paths";
import { FileNotFoundError } from "lib/errors";

const logger = globalLogger.withDefaults({
  message: colorize("blackBright", `Chat API: `),
});

const MAX_INLINE_IMAGE_BYTES =
  Number.parseInt(process.env.INLINE_IMAGE_MAX_BYTES ?? "", 10) ||
  2 * 1024 * 1024; // 2 MB default to accommodate stricter providers

const MAX_INLINE_IMAGE_PIXELS =
  Number.parseInt(process.env.INLINE_IMAGE_MAX_PIXELS ?? "", 10) || 1_200_000; // ~1.2MP default

const maybeOptimizeImageForInline = async (
  buffer: Buffer,
  contentType?: string | null,
) => {
  if (!contentType?.startsWith("image/")) {
    return { buffer, contentType };
  }

  if (buffer.byteLength <= MAX_INLINE_IMAGE_BYTES) {
    return { buffer, contentType };
  }

  try {
    const sharp = (await import("sharp")).default;
    const base = sharp(buffer, { failOnError: false });
    const metadata = await base.metadata();

    if ((metadata.width ?? 0) === 0 || (metadata.height ?? 0) === 0) {
      return { buffer, contentType };
    }

    const pixelCount = (metadata.width ?? 0) * (metadata.height ?? 0);
    let scale = 1;
    if (pixelCount > MAX_INLINE_IMAGE_PIXELS) {
      scale = Math.sqrt(MAX_INLINE_IMAGE_PIXELS / pixelCount);
    }

    const targetDimensions = () => {
      if (scale >= 1) {
        return undefined;
      }
      const targetWidth = Math.max(
        1,
        Math.floor((metadata.width ?? 0) * scale),
      );
      const targetHeight = Math.max(
        1,
        Math.floor((metadata.height ?? 0) * scale),
      );
      return { width: targetWidth, height: targetHeight };
    };

    const qualities = [75, 65, 55, 45];
    let best: { data: Buffer; info?: { format?: string } | null } | null = null;
    for (const quality of qualities) {
      let attempt = sharp(buffer, { failOnError: false });
      if (scale < 1) {
        const dims = targetDimensions();
        if (dims) {
          attempt = attempt.resize({
            width: dims.width,
            height: dims.height,
            fit: "inside",
            withoutEnlargement: true,
          });
        }
      }

      const { data, info } = await attempt
        .webp({ quality })
        .toBuffer({ resolveWithObject: true });

      if (!best || data.length < best.data.length) {
        best = { data, info };
      }

      if (data.length <= MAX_INLINE_IMAGE_BYTES) {
        return {
          buffer: data,
          contentType: info?.format ? `image/${info.format}` : "image/webp",
        };
      }
    }

    if (best && best.data.length < buffer.byteLength) {
      return {
        buffer: best.data,
        contentType: best.info?.format
          ? `image/${best.info.format}`
          : "image/webp",
      };
    }

    return { buffer, contentType };
  } catch (error) {
    logger.error("Failed to optimize inline image for provider", error);
    return { buffer, contentType };
  }
};

const inlineFilePartsAsDataUrls = async (
  messages: UIMessage[],
): Promise<UIMessage[]> => {
  const cache = new Map<
    string,
    { base64: string; contentType?: string | null }
  >();

  const transformPart = async (part: UIMessage["parts"][number]) => {
    if (part.type !== "file") {
      return part;
    }

    if (part.url.startsWith("data:")) {
      return part;
    }

    const providerMetadata = part.providerMetadata as
      | Record<string, { storageKey?: string; storageUrl?: string }>
      | undefined;
    const storageMetadata = providerMetadata?.["better-chatbot"];
    const storageKey =
      storageMetadata?.storageKey ?? extractStorageKeyFromUrl(part.url);

    if (!storageKey) {
      return part;
    }

    try {
      let cached = cache.get(storageKey);
      if (!cached) {
        const [buffer, metadata] = await Promise.all([
          serverFileStorage.download(storageKey),
          serverFileStorage.getMetadata(storageKey),
        ]);
        const optimized = await maybeOptimizeImageForInline(
          buffer,
          metadata?.contentType,
        );
        cached = {
          base64: optimized.buffer.toString("base64"),
          contentType: optimized.contentType ?? metadata?.contentType,
        };
        cache.set(storageKey, cached);
      }

      const contentType =
        part.mediaType || cached.contentType || "application/octet-stream";

      return {
        ...part,
        url: `data:${contentType};base64,${cached.base64}`,
      };
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        logger.warn(
          `File not found in storage while preparing provider payload: ${storageKey}`,
        );
        return part;
      }
      logger.error(
        `Failed to inline storage file for provider: ${storageKey}`,
        error,
      );
      return part;
    }
  };

  return Promise.all(
    messages.map(async (message) => ({
      ...message,
      parts: await Promise.all(message.parts.map(transformPart)),
    })),
  );
};

export async function POST(request: Request) {
  try {
    const json = await request.json();

    const session = await getSession();

    if (!session?.user.id) {
      return new Response("Unauthorized", { status: 401 });
    }
    const {
      id,
      message,
      chatModel,
      toolChoice,
      allowedAppDefaultToolkit,
      allowedMcpServers,
      imageTool,
      mentions = [],
    } = chatApiSchemaRequestBodySchema.parse(json);

    const model = customModelProvider.getModel(chatModel);

    let thread = await chatRepository.selectThreadDetails(id);

    if (!thread) {
      logger.info(`create chat thread: ${id}`);
      const newThread = await chatRepository.insertThread({
        id,
        title: "",
        userId: session.user.id,
      });
      thread = await chatRepository.selectThreadDetails(newThread.id);
    }

    if (thread!.userId !== session.user.id) {
      return new Response("Forbidden", { status: 403 });
    }

    const messages: UIMessage[] = (thread?.messages ?? []).map((m) => {
      return {
        id: m.id,
        role: m.role,
        parts: m.parts,
        metadata: m.metadata,
      };
    });

    if (messages.at(-1)?.id == message.id) {
      messages.pop();
    }
    messages.push(message);

    const supportToolCall = !isToolCallUnsupportedModel(model);

    const agentId = (
      mentions.find((m) => m.type === "agent") as Extract<
        ChatMention,
        { type: "agent" }
      >
    )?.agentId;

    const agent = await rememberAgentAction(agentId, session.user.id);

    if (agent?.instructions?.mentions) {
      mentions.push(...agent.instructions.mentions);
    }

    const useImageTool = Boolean(imageTool?.model);

    const isToolCallAllowed =
      supportToolCall &&
      (toolChoice != "none" || mentions.length > 0) &&
      !useImageTool;

    const metadata: ChatMetadata = {
      agentId: agent?.id,
      toolChoice: toolChoice,
      toolCount: 0,
      chatModel: chatModel,
    };

    const stream = createUIMessageStream({
      execute: async ({ writer: dataStream }) => {
        const mcpClients = await mcpClientsManager.getClients();
        const mcpTools = await mcpClientsManager.tools();
        logger.info(
          `mcp-server count: ${mcpClients.length}, mcp-tools count :${Object.keys(mcpTools).length}`,
        );
        const MCP_TOOLS = await safe()
          .map(errorIf(() => !isToolCallAllowed && "Not allowed"))
          .map(() =>
            loadMcpTools({
              mentions,
              allowedMcpServers,
            }),
          )
          .orElse({});

        const WORKFLOW_TOOLS = await safe()
          .map(errorIf(() => !isToolCallAllowed && "Not allowed"))
          .map(() =>
            loadWorkFlowTools({
              mentions,
              dataStream,
            }),
          )
          .orElse({});

        const APP_DEFAULT_TOOLS = await safe()
          .map(errorIf(() => !isToolCallAllowed && "Not allowed"))
          .map(() =>
            loadAppDefaultTools({
              mentions,
              allowedAppDefaultToolkit,
            }),
          )
          .orElse({});
        const inProgressToolParts = extractInProgressToolPart(message);
        if (inProgressToolParts.length) {
          await Promise.all(
            inProgressToolParts.map(async (part) => {
              const output = await manualToolExecuteByLastMessage(
                part,
                { ...MCP_TOOLS, ...WORKFLOW_TOOLS, ...APP_DEFAULT_TOOLS },
                request.signal,
              );
              part.output = output;

              dataStream.write({
                type: "tool-output-available",
                toolCallId: part.toolCallId,
                output,
              });
            }),
          );
        }

        const userPreferences = thread?.userPreferences || undefined;

        const mcpServerCustomizations = await safe()
          .map(() => {
            if (Object.keys(MCP_TOOLS ?? {}).length === 0)
              throw new Error("No tools found");
            return rememberMcpServerCustomizationsAction(session.user.id);
          })
          .map((v) => filterMcpServerCustomizations(MCP_TOOLS!, v))
          .orElse({});

        const systemPrompt = mergeSystemPrompt(
          buildUserSystemPrompt(session.user, userPreferences, agent),
          buildMcpServerCustomizationsSystemPrompt(mcpServerCustomizations),
          !supportToolCall && buildToolCallUnsupportedModelSystemPrompt,
        );

        const IMAGE_TOOL: Record<string, Tool> = useImageTool
          ? {
              [ImageToolName]:
                imageTool?.model === "google"
                  ? nanoBananaTool
                  : openaiImageTool,
            }
          : {};
        const vercelAITooles = safe({
          ...MCP_TOOLS,
          ...WORKFLOW_TOOLS,
        })
          .map((t) => {
            const bindingTools =
              toolChoice === "manual" ||
              (message.metadata as ChatMetadata)?.toolChoice === "manual"
                ? excludeToolExecution(t)
                : t;
            return {
              ...bindingTools,
              ...APP_DEFAULT_TOOLS, // APP_DEFAULT_TOOLS Not Supported Manual
              ...IMAGE_TOOL,
            };
          })
          .unwrap();
        metadata.toolCount = Object.keys(vercelAITooles).length;

        const allowedMcpTools = Object.values(allowedMcpServers ?? {})
          .map((t) => t.tools)
          .flat();

        logger.info(
          `${agent ? `agent: ${agent.name}, ` : ""}tool mode: ${toolChoice}, mentions: ${mentions.length}`,
        );

        logger.info(
          `allowedMcpTools: ${allowedMcpTools.length ?? 0}, allowedAppDefaultToolkit: ${allowedAppDefaultToolkit?.length ?? 0}`,
        );
        if (useImageTool) {
          logger.info(`binding tool count Image: ${imageTool?.model}`);
        } else {
          logger.info(
            `binding tool count APP_DEFAULT: ${Object.keys(APP_DEFAULT_TOOLS ?? {}).length}, MCP: ${Object.keys(MCP_TOOLS ?? {}).length}, Workflow: ${Object.keys(WORKFLOW_TOOLS ?? {}).length}`,
          );
        }
        logger.info(`model: ${chatModel?.provider}/${chatModel?.model}`);

        const providerMessages = await inlineFilePartsAsDataUrls(messages);

        const result = streamText({
          model,
          system: systemPrompt,
          messages: convertToModelMessages(providerMessages),
          experimental_transform: smoothStream({ chunking: "word" }),
          maxRetries: 2,
          tools: vercelAITooles,
          stopWhen: stepCountIs(10),
          toolChoice: "auto",
          abortSignal: request.signal,
        });
        result.consumeStream();
        dataStream.merge(
          result.toUIMessageStream({
            messageMetadata: ({ part }) => {
              if (part.type == "finish") {
                metadata.usage = part.totalUsage;
                return metadata;
              }
            },
          }),
        );
      },

      generateId: generateUUID,
      onFinish: async ({ responseMessage }) => {
        if (responseMessage.id == message.id) {
          await chatRepository.upsertMessage({
            threadId: thread!.id,
            ...responseMessage,
            parts: responseMessage.parts.map(convertToSavePart),
            metadata,
          });
        } else {
          await chatRepository.upsertMessage({
            threadId: thread!.id,
            role: message.role,
            parts: message.parts.map(convertToSavePart),
            id: message.id,
          });
          await chatRepository.upsertMessage({
            threadId: thread!.id,
            role: responseMessage.role,
            id: responseMessage.id,
            parts: responseMessage.parts.map(convertToSavePart),
            metadata,
          });
        }

        if (agent) {
          agentRepository.updateAgent(agent.id, session.user.id, {
            updatedAt: new Date(),
          } as any);
        }
      },
      onError: handleError,
      originalMessages: messages,
    });

    return createUIMessageStreamResponse({
      stream,
    });
  } catch (error: any) {
    logger.error(error);
    return Response.json({ message: error.message }, { status: 500 });
  }
}
