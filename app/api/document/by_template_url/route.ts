import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
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
 * 下载模板URL为Buffer
 */
async function downloadTemplateAsBuffer(url: string): Promise<Buffer> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("template_url 不是合法URL");
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("template_url 只支持 http/https");
  }

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

    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);

    const max = 10 * 1024 * 1024;
    if (buf.length > max) {
      throw new Error("模板文件过大（超过 10MB）");
    }

    return buf;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 生成上传文件名
 */
function createFileName(format: SupportedFormat): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  return `document_${timestamp}.${format}`;
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const buffer = await request.arrayBuffer();
    const readable = Readable.from(Buffer.from(buffer));

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

    const form = formidable({
      multiples: false,
      keepExtensions: true,
      maxFileSize: 10 * 1024 * 1024,
    });

    const [fields, files] = await form.parse(mockRequest);

    const format = (Array.isArray(fields.format) ? fields.format[0] : fields.format || "docx").toLowerCase() as SupportedFormat;

    const dataString = Array.isArray(fields.data) ? fields.data[0] : fields.data;
    if (!dataString) {
      return NextResponse.json({ success: false, error: "缺少 data 参数" }, { status: 400 });
    }

    let data: DocumentData;
    try {
      data = JSON.parse(dataString);
    } catch {
      return NextResponse.json(
        { success: false, error: "data 参数格式错误，必须是有效的 JSON" },
        { status: 400 }
      );
    }

    let templateBuffer: Buffer | null = null;

    // 兼容上传文件
    const templateFile = Array.isArray(files.template) ? files.template[0] : files.template;
    if (templateFile) {
      templateBuffer = await fs.promises.readFile(templateFile.filepath);
    } else {
      // 兼容 template 或 template_url 传链接
      const templateField =
        (Array.isArray(fields.template) ? fields.template[0] : fields.template) ||
        (Array.isArray(fields.template_url) ? fields.template_url[0] : fields.template_url);

      if (!templateField || typeof templateField !== "string") {
        return NextResponse.json(
          { success: false, error: "缺少模板：请上传 template 文件或传 template_url" },
          { status: 400 }
        );
      }

      templateBuffer = await downloadTemplateAsBuffer(templateField);
    }

    const docBuffer = await generateDocxBuffer(data, templateBuffer, "buffer");

    const formatHandlers: Record<SupportedFormat, FormatHandler> = {
      docx: {
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        fileExtension: "docx",
        process: async (buf: Buffer) => buf,
      },
      pdf: {
        contentType: "application/pdf",
        fileExtension: "pdf",
        process: async (buf: Buffer) => {
          try {
            return await convertDocxToPdf(buf);
          } catch (error) {
            console.error("PDF 转换失败:", error);
            throw new Error("PDF 转换失败");
          }
        },
      },
      png: {
        contentType: "image/png",
        fileExtension: "png",
        process: async (buf: Buffer) => {
          try {
            return await convertDocxToImage(buf, "png");
          } catch (error) {
            console.error("PNG 转换失败:", error);
            throw new Error("PNG 转换失败");
          }
        },
      },
      jpg: {
        contentType: "image/jpeg",
        fileExtension: "jpg",
        process: async (buf: Buffer) => {
          try {
            return await convertDocxToImage(buf, "jpg");
          } catch (error) {
            console.error("JPG 转换失败:", error);
            throw new Error("JPG 转换失败");
          }
        },
      },
      jpeg: {
        contentType: "image/jpeg",
        fileExtension: "jpeg",
        process: async (buf: Buffer) => {
          try {
            return await convertDocxToImage(buf, "jpeg");
          } catch (error) {
            console.error("JPEG 转换失败:", error);
            throw new Error("JPEG 转换失败");
          }
        },
      },
    };

    if (!formatHandlers[format]) {
      return NextResponse.json(
        {
          success: false,
          error: `不支持的格式: ${format}`,
          supportedFormats: Object.keys(formatHandlers),
        },
        { status: 400 }
      );
    }

    const handler = formatHandlers[format];

    try {
      const processedBuffer = await handler.process(docBuffer);

      const fileName = createFileName(format);

      // 上传到 Vercel Blob，返回公开链接
      const blob = await put(fileName, processedBuffer, {
        access: "public",
        contentType: handler.contentType,
      });

      return NextResponse.json({
        success: true,
        message: "文档生成成功",
        file_url: blob.url,
        file_name: fileName,
        format,
        content_type: handler.contentType,
      });
    } catch (error) {
      console.error(`${format.toUpperCase()} 处理或上传失败:`, error);
      return NextResponse.json(
        {
          success: false,
          error: `${format.toUpperCase()} 处理或上传失败`,
        },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error("文档生成失败:", error);
    return NextResponse.json(
      {
        success: false,
        error: "文档生成失败",
      },
      { status: 500 }
    );
  }
}