

import { NextResponse } from "next/server";
import { convertDocxToPdf } from "@/services/pdfConverter";
import { convertDocxToImage } from "@/services/imageConverter";
import { generateDocxBuffer, type DocumentData } from "@/services/docxTemplateService";
import formidable from "formidable";
import { Readable } from "stream";
import fs from "fs";

// 定义支持的格式类型
type SupportedFormat = "docx" | "pdf" | "png" | "jpg" | "jpeg";

// 格式处理器接口
interface FormatHandler {
  contentType: string;
  fileExtension: string;
  process: (docBuffer: Buffer) => Promise<Buffer>;
}

/**
 * 下载模板URL为Buffer（后端负责把“链接”转成二进制）
 */
async function downloadTemplateAsBuffer(url: string): Promise<Buffer> {
  // 简单校验
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("template_url 不是合法URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("template_url 只支持 http/https");
  }

  // 超时控制
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`模板下载失败：HTTP ${res.status}`);
    }

    // 可选：检查 content-type（不强制，因为很多下载链接可能是 application/octet-stream）
    // const ct = res.headers.get("content-type") || "";

    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);

    // 可选：限制大小，防止被喂超大文件（这里给 10MB，和你上传限制一致）
    const max = 10 * 1024 * 1024;
    if (buf.length > max) {
      throw new Error("模板文件过大（超过 10MB）");
    }

    return buf;
  } finally {
    clearTimeout(timeout);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    // 创建一个可读流来模拟 IncomingMessage
    const buffer = await request.arrayBuffer();
    const readable = Readable.from(Buffer.from(buffer));

    // 添加必要的属性来模拟 IncomingMessage
    const mockRequest = Object.assign(readable, {
      headers: Object.fromEntries(request.headers.entries()),
      method: request.method,
      url: request.url,
      httpVersion: "1.1",
      httpVersionMajor: 1,
      httpVersionMinor: 1,
      complete: true,
      connection: null,
      socket: null,
      aborted: false,
    }) as unknown as import("http").IncomingMessage;

    // 使用 formidable 解析表单数据
    const form = formidable({
      multiples: false,
      keepExtensions: true,
      maxFileSize: 10 * 1024 * 1024, // 10MB
    });

    const [fields, files] = await form.parse(mockRequest);

    // 获取 format 参数，默认为 docx
    const format = Array.isArray(fields.format) ? fields.format[0] : fields.format || "docx";

    // 获取 data 参数并解析为 JSON
    const dataString = Array.isArray(fields.data) ? fields.data[0] : fields.data;
    if (!dataString) {
      return new NextResponse(JSON.stringify({ error: "缺少 data 参数" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    let data: DocumentData;
    try {
      data = JSON.parse(dataString);
    } catch {
      return new NextResponse(JSON.stringify({ error: "data 参数格式错误，必须是有效的 JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    /**
     * ✅ 这里开始是关键改造：
     * - 优先用上传文件 files.template（兼容旧逻辑）
     * - 否则用 fields.template / fields.template_url 当做 URL 去下载成 Buffer
     */
    let templateBuffer: Buffer | null = null;

    // 1) 兼容旧：上传的模板文件
    const templateFile = Array.isArray(files.template) ? files.template[0] : files.template;
    if (templateFile) {
      templateBuffer = await fs.promises.readFile(templateFile.filepath);
    } else {
      // 2) 新：template 是 URL（工作流“附件转链接”的输出）
      const templateField =
        (Array.isArray(fields.template) ? fields.template[0] : fields.template) ||
        (Array.isArray(fields.template_url) ? fields.template_url[0] : fields.template_url);

      if (!templateField || typeof templateField !== "string") {
        return new NextResponse(JSON.stringify({ error: "缺少模板：请上传 template 文件或传 template_url" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      templateBuffer = await downloadTemplateAsBuffer(templateField);
    }

    // 生成DOCX文档
    const docBuffer = await generateDocxBuffer(data, templateBuffer, "buffer");

    // 使用格式处理器处理不同的输出格式
    const normalizedFormat = format.toLowerCase() as SupportedFormat;

    // 检查是否支持该格式
    if (!formatHandlers[normalizedFormat]) {
      return new NextResponse(
        JSON.stringify({
          error: `不支持的格式: ${format}`,
          supportedFormats: Object.keys(formatHandlers),
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const handler = formatHandlers[normalizedFormat];

    try {
      const processedBuffer = await handler.process(docBuffer);

      // 让浏览器下载（飞书里一般是“HTTP 节点拿到响应”，最终你要写回附件字段）
      return new NextResponse(new Uint8Array(processedBuffer), {
        headers: {
          "Content-Type": handler.contentType,
          "Content-Disposition": `attachment; filename="document_converted.${handler.fileExtension}"`,
        },
      });
    } catch (error) {
      console.error(`${format.toUpperCase()} 转换失败:`, error);
      return new NextResponse(JSON.stringify({ error: `${format.toUpperCase()} 转换失败` }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  } catch (error) {
    console.error("文档生成失败:", error);
    return new NextResponse(JSON.stringify({ error: "文档生成失败" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// 格式处理器映射
const formatHandlers: Record<SupportedFormat, FormatHandler> = {
  docx: {
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    fileExtension: "docx",
    process: async (docBuffer: Buffer) => docBuffer,
  },
  pdf: {
    contentType: "application/pdf",
    fileExtension: "pdf",
    process: async (docBuffer: Buffer) => {
      try {
        return await convertDocxToPdf(docBuffer);
      } catch (error) {
        console.error("PDF 转换失败:", error);
        throw new Error("PDF 转换失败");
      }
    },
  },
  png: {
    contentType: "image/png",
    fileExtension: "png",
    process: async (docBuffer: Buffer) => {
      try {
        return await convertDocxToImage(docBuffer, "png");
      } catch (error) {
        console.error("PNG 转换失败:", error);
        throw new Error("PNG 转换失败");
      }
    },
  },
  jpg: {
    contentType: "image/jpeg",
    fileExtension: "jpg",
    process: async (docBuffer: Buffer) => {
      try {
        return await convertDocxToImage(docBuffer, "jpg");
      } catch (error) {
        console.error("JPG 转换失败:", error);
        throw new Error("JPG 转换失败");
      }
    },
  },
  jpeg: {
    contentType: "image/jpeg",
    fileExtension: "jpeg",
    process: async (docBuffer: Buffer) => {
      try {
        return await convertDocxToImage(docBuffer, "jpeg");
      } catch (error) {
        console.error("JPEG 转换失败:", error);
        throw new Error("JPEG 转换失败");
      }
    },
  },
};