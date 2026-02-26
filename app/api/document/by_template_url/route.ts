// app/api/document/by_template_url/route.ts 
 import { put } from "@vercel/blob"; 
 
 export const runtime = "nodejs"; 
 let cachedTemplate: Buffer | null = null;

async function getTemplate(url: string) {
  if (cachedTemplate) return cachedTemplate;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`模板下载失败：${r.status}`);
  cachedTemplate = Buffer.from(await r.arrayBuffer());
  return cachedTemplate;
}
 type CertData = { 姓名: string; 日期: string; 奖项: string }; 
 
 async function downloadAsBuffer(url: string): Promise<Buffer> { 
   const r = await fetch(url); 
   if (!r.ok) throw new Error(`模板下载失败：${r.status}`); 
   const ab = await r.arrayBuffer(); 
   return Buffer.from(ab); 
 } 
 
 // ✅ 这里接入你“已经写好的生成逻辑” 
 async function generateCertificate(templateBuf: Buffer, data: CertData): Promise<Buffer> { 
   // TODO: 把你现有生成函数搬进来，返回生成后的文件 Buffer（pdf/docx/png 都行） 
   // 先用模板原样返回，方便你先打通链路 
   return templateBuf; 
 } 
 
 export async function POST(req: Request) { 
   try { 
     const form = await req.formData(); 
 
     const templateUrl = String(form.get("template_url") || ""); 
     const dataStr = String(form.get("data") || ""); 
 
     if (!templateUrl) return Response.json({ error: "缺少 template_url" }, { status: 400 }); 
     if (!dataStr) return Response.json({ error: "缺少 data" }, { status: 400 }); 
 
     let dataObj: any; 
     try { 
       dataObj = JSON.parse(dataStr); 
     } catch { 
       return Response.json({ error: "data 参数格式错误，必须是有效的 JSON" }, { status: 400 }); 
     } 
 
     const templateBuf = await downloadAsBuffer(templateUrl); 
     const outBuf = await generateCertificate(templateBuf, dataObj as CertData); 
 
     // 上传到 Vercel Blob（public，直接返回 URL） 
     const safeName = encodeURIComponent((dataObj.姓名 || "unknown").toString()); 
     const filename = `certs/${Date.now()}-${safeName}.docx`;
 
     const blob = await put(filename, outBuf, {
        access: "public",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
     });
     return Response.json({ url: blob.url }, { status: 200 }); 
   } catch (e: any) { 
     return Response.json({ error: e?.message || String(e) }, { status: 500 }); 
   } 
 }