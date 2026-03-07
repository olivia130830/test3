import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { convertDocxToPdf } from "@/services/pdfConverter";
import { convertDocxToImage } from "@/services/imageConverter";
import { generateDocxBuffer, type DocumentData } from "@/services/docxTemplateService";

// 定义支持的格式类型
type SupportedFormat = "docx" | "pdf" | "png" | "jpg" | "jpeg";

// 格式处理器接口
interface FormatHandler {
  contentType: string;
  fileExtension: string;
  process: (docBuffer: Buffer) => Promise<Buffer>;
}

/**
 * 下载模板 URL 为 Buffer
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
 * 生成文件名
 */
function createFileName(format: SupportedFormat): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  return `document_${timestamp}.${format}`;
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

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const formData = await request.formData();

    const formatValue = formData.get("format");
    const normalizedFormat = String(formatValue || "docx").toLowerCase() as SupportedFormat;

    const dataValue = formData.get("data");
    if (!dataValue || typeof dataValue !== "string") {
      return NextResponse.json(
        { success: false, error: "缺少 data 参数" },
        { status: 400 }
      );
    }

    let data: DocumentData;
    try {
      data = JSON.parse(dataValue);
    } catch {
      return NextResponse.json(
        { success: false, error: "data 参数格式错误，必须是有效的 JSON" },
        { status: 400 }
      );
    }

    let templateBuffer: Buffer;

    const templateFile = formData.get("template");
    if (templateFile instanceof File) {
      const ab = await templateFile.arrayBuffer();
      templateBuffer = Buffer.from(ab);
    } else {
      const templateField = formData.get("template_url") || formData.get("template");

      if (!templateField || typeof templateField !== "string") {
        return NextResponse.json(
          { success: false, error: "缺少模板：请上传 template 文件或传 template_url" },
          { status: 400 }
        );
      }

      templateBuffer = await downloadTemplateAsBuffer(templateField);
    }

    if (!formatHandlers[normalizedFormat]) {
      return NextResponse.json(
        {
          success: false,
          error: `不支持的格式: ${normalizedFormat}`,
          supportedFormats: Object.keys(formatHandlers),
        },
        { status: 400 }
      );
    }

    const docBuffer = await generateDocxBuffer(data, templateBuffer, "buffer");
    const handler = formatHandlers[normalizedFormat];
    const processedBuffer = await handler.process(docBuffer);
    const fileName = createFileName(normalizedFormat);

    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) {
      return NextResponse.json(
        {
          success: false,
          error: "缺少 BLOB_READ_WRITE_TOKEN 环境变量",
        },
        { status: 500 }
      );
    }

    const blob = await put(fileName, processedBuffer, {
      access: "public",
      contentType: handler.contentType,
      token,
    });

    return NextResponse.json({
      success: true,
      message: "文档生成成功",
      file_url: blob.url,
      file_name: fileName,
      format: normalizedFormat,
      content_type: handler.contentType,
    });
  } catch (error: any) {
    console.error("文档生成失败:", error);
    return NextResponse.json(
      {
        success: false,
        error: "文档生成失败",
        detail: error?.message || String(error),
      },
      { status: 500 }
    );
  }
}