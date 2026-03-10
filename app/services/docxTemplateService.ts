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
    const zip = new PizZip(template);

    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
    });

    doc.render(data);

    const buffer = doc.getZip().generate({
      type: "nodebuffer",
      compression: "DEFLATE",
    });

    return buffer;
  } catch (error: any) {
    throw new Error(error?.message || "DOCX 模板渲染失败");
  }
}