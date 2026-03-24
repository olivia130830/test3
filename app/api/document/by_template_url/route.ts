/*
 * @Author: 杨仕明 shiming.y@qq.com
 */

import { NextResponse } from "next/server";
import { convertDocxToPdf } from "@/services/pdfConverter";
import { convertDocxToImage } from "@/services/imageConverter";
import { generateDocxBuffer, type DocumentData } from "@/services/docxTemplateService";
import formidable from "formidable";
import { Readable } from "stream";
import fs from "fs";
import { put } from "@vercel/blob"; // ✅【新增1】

// 定义支持的格式类型
type SupportedFormat = 'docx' | 'pdf' | 'png' | 'jpg' | 'jpeg';

// 格式处理器接口
interface FormatHandler {
    contentType: string;
    fileExtension: string;
    process: (docBuffer: Buffer) => Promise<Buffer>;
}

export async function POST(request: Request): Promise<NextResponse> {
    try {
        const buffer = await request.arrayBuffer();
        const readable = Readable.from(Buffer.from(buffer));

        const mockRequest = Object.assign(readable, {
            headers: Object.fromEntries(request.headers.entries()),
            method: request.method,
            url: request.url,
            httpVersion: '1.1',
            httpVersionMajor: 1,
            httpVersionMinor: 1,
            complete: true,
            connection: null,
            socket: null,
            aborted: false,
        }) as unknown as import('http').IncomingMessage;

        const form = formidable({
            multiples: false,
            keepExtensions: true,
            maxFileSize: 10 * 1024 * 1024,
        });

        const [fields, files] = await form.parse(mockRequest);

        const format = Array.isArray(fields.format) ? fields.format[0] : fields.format || 'docx';

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
            return new NextResponse(JSON.stringify({ error: "data 参数格式错误" }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
            });
        }

        const templateFile = Array.isArray(files.template) ? files.template[0] : files.template;
        if (!templateFile) {
            return new NextResponse(JSON.stringify({ error: "缺少模板文件" }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
            });
        }

        const templateBuffer = await fs.promises.readFile(templateFile.filepath);

        const docBuffer = await generateDocxBuffer(data, templateBuffer, 'buffer');

        const normalizedFormat = format.toLowerCase() as SupportedFormat;

        if (!formatHandlers[normalizedFormat]) {
            return new NextResponse(
                JSON.stringify({
                    error: `不支持的格式: ${format}`,
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

            // ✅【新增2：上传到云】
            const token = process.env.BLOB_READ_WRITE_TOKEN;
            if (!token) {
                return NextResponse.json({ error: "缺少 BLOB_READ_WRITE_TOKEN" }, { status: 500 });
            }

            const fileName = `document_${Date.now()}.${handler.fileExtension}`;

            const blob = await put(fileName, processedBuffer, {
                access: "public",
                contentType: handler.contentType,
                token,
            });

            // ✅【新增3：返回 URL 而不是文件】
            return NextResponse.json({
                file_url: blob.url,
            });

        } catch (error: unknown) {
            console.error(`${format.toUpperCase()} 转换失败:`, error);
            return NextResponse.json(
                { error: `${format.toUpperCase()} 转换失败` },
                { status: 500 }
            );
        }
    } catch (error: unknown) {
        console.error("文档生成失败:", error);
        return NextResponse.json(
            { error: "文档生成失败" },
            { status: 500 }
        );
    }
}

// 格式处理器映射（完全没动）
const formatHandlers: Record<SupportedFormat, FormatHandler> = {
    docx: {
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        fileExtension: 'docx',
        process: async (docBuffer: Buffer) => docBuffer,
    },
    pdf: {
        contentType: 'application/pdf',
        fileExtension: 'pdf',
        process: async (docBuffer: Buffer) => {
            return await convertDocxToPdf(docBuffer);
        },
    },
    png: {
        contentType: 'image/png',
        fileExtension: 'png',
        process: async (docBuffer: Buffer) => {
            return await convertDocxToImage(docBuffer, 'png');
        },
    },
    jpg: {
        contentType: 'image/jpeg',
        fileExtension: 'jpg',
        process: async (docBuffer: Buffer) => {
            return await convertDocxToImage(docBuffer, 'jpg');
        },
    },
    jpeg: {
        contentType: 'image/jpeg',
        fileExtension: 'jpeg',
        process: async (docBuffer: Buffer) => {
            return await convertDocxToImage(docBuffer, 'jpeg');
        },
    },
};