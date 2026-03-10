import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";

export interface DocumentData {
  [key: string]: any;
}

export async function generateDocxBuffer(
  data: DocumentData,
  template: Buffer,
  output: string
): Promise<Buffer> {
  try {
    console.log("收到的 data =", data);

    const zip = new PizZip(template);
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
    });

    doc.render(data);
    console.log("模板变量替换完成");

    const buffer = doc.getZip().generate({
      type: "nodebuffer",
      compression: "DEFLATE",
    });

    return buffer;
  } catch (error: any) {
    console.error("DOCX 模板渲染失败:", error);
    throw new Error(error?.message || "DOCX 模板渲染失败");
  }
}