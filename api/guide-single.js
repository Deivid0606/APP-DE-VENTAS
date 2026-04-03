import { PDFDocument, StandardFonts } from 'pdf-lib';
import { supabase } from '../lib/supabase.js';
import { decodeSession } from '../lib/auth.js';
import { buildGuideText } from '../lib/utils.js';

export default async function handler(req, res) {
  try {
    const { token, orderId } = req.query || {};
    decodeSession(token);
    const { data } = await supabase.from('orders').select('*, order_items(*)').eq('id', orderId).single();
    const order = { ...data, items: data.order_items || [] };
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([595, 842]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    let y = 800;
    page.drawText(`Guía de entrega #${order.id}`, { x: 40, y, size: 18, font: bold });
    y -= 28;
    for (const line of buildGuideText(order).split('\n')) {
      page.drawText(line, { x: 40, y, size: 11, font });
      y -= 16;
    }
    const bytes = await pdf.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="guia-${order.id}.pdf"`);
    res.send(Buffer.from(bytes));
  } catch (error) {
    res.status(500).send(String(error.message || error));
  }
}
