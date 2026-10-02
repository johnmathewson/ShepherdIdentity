export const FREQUENCIES = {
  weekly:    { label: 'Weekly',    perYear: 52, per: 'week' },
  monthly:   { label: 'Monthly',   perYear: 12, per: 'month' },
  quarterly: { label: 'Quarterly', perYear: 4,  per: 'quarter' },
  annually:  { label: 'Annually',  perYear: 1,  per: 'year' },
  one_time:  { label: 'One-time',  perYear: 0,  per: 'gift' },
  unspecified: { label: 'Not specified', perYear: 0, per: 'period', hidden: true },
};

export function installmentFor(amountTotal, termYears, frequency) {
  const f = FREQUENCIES[frequency];
  if (!f) return null;
  if (frequency === 'one_time') return round2(amountTotal);
  if (frequency === 'unspecified') return null;
  const n = f.perYear * termYears;
  return n > 0 ? round2(amountTotal / n) : null;
}

export function round2(n) { return Math.round(Number(n) * 100) / 100; }

export function money(n, opts = {}) {
  const v = Number(n) || 0;
  const cents = opts.cents ?? !Number.isInteger(v);
  return '$' + v.toLocaleString('en-US', {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  });
}

export function longDate(d = new Date(), tz = 'America/Indiana/Indianapolis') {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, month: 'long', day: 'numeric', year: 'numeric',
  }).format(d instanceof Date ? d : new Date(d));
}

export function termWord(n) {
  return ['', 'one', 'two', 'three', 'four', 'five'][n] || String(n);
}
export function termPhrase(n) { return `${termWord(n)} year${n === 1 ? '' : 's'}`; }

export async function fillPledgeCard({ PDFLib, fontkit, templateBytes, fonts = {}, pledge, signaturePng }) {
  const { PDFDocument, rgb, StandardFonts } = PDFLib;
  const pdf = await PDFDocument.load(templateBytes);
  if (fontkit) pdf.registerFontkit(fontkit);

  const embed = async (bytes, fallback) => {
    if (bytes && fontkit) {
      try { return await pdf.embedFont(bytes, { subset: true }); } catch (_) { /* fall through */ }
    }
    return pdf.embedFont(fallback);
  };
  const fHead = await embed(fonts.montserrat, StandardFonts.HelveticaBold);
  const fBody = await embed(fonts.lato, StandardFonts.Helvetica);
  const fBodyB = await embed(fonts.latoBold, StandardFonts.HelveticaBold);
  const fBodyI = await embed(fonts.latoItalic, StandardFonts.HelveticaOblique);

  const page = pdf.getPages()[0];
  const INK = rgb(0.106, 0.125, 0.153);
  const CORAL = rgb(1, 0.384, 0.251);
  const MUTED = rgb(0.384, 0.435, 0.486);
  const WHITE = rgb(1, 1, 1);
  const Y = (top) => 792 - top;
  const tick = (x, top, size) => page.drawRectangle({ x: x + 2.5, y: Y(top) + 2.5, width: size, height: size, color: CORAL });

  const amount = Number(pledge.amount_total);
  const term = Number(pledge.term_years) || 5;
  const inst = installmentFor(amount, term, pledge.frequency);
  const when = pledge.signed_at || pledge.created_at || new Date();
  const oneTime = pledge.frequency === 'one_time';

  page.drawText(money(amount, { cents: false }), { x: 68, y: 481, size: 20, font: fHead, color: INK });

  page.drawRectangle({ x: 260, y: 473, width: 310, height: 20, color: WHITE });
  page.drawText(oneTime ? 'as a one-time gift,' : `over ${termPhrase(term)},`, { x: 262.4, y: 479, size: 11, font: fBody, color: CORAL });

  if (inst != null && pledge.frequency !== 'unspecified') page.drawText(money(inst), { x: 122, y: 457, size: 11.5, font: fBodyB, color: INK });
  const freqBoxX = { weekly: 245.8, monthly: 308.6, quarterly: 377.4, annually: 450.5 };
  if (freqBoxX[pledge.frequency] != null) tick(freqBoxX[pledge.frequency], 339.6, 7);

  if (pledge.start_date) {
    page.drawText(longDate(String(pledge.start_date).slice(0, 10) + 'T12:00:00'), { x: 98, y: 436.5, size: 10.5, font: fBody, color: INK });
  } else {
    page.drawText('with my first gift', { x: 98, y: 436.5, size: 10, font: fBodyI, color: MUTED });
  }

  if (pledge.recurring_setup) {
    tick(61.2, 398.7, 7);
    if (pledge.recurring_method === 'ach') tick(61.2, 419.9, 6);
    if (pledge.recurring_method === 'card') tick(165.9, 419.9, 6);
  }

  const firstGift = Number(pledge.first_gift_amount) || 0;
  if (firstGift > 0) {
    tick(43.2, 456.4, 7);
    page.drawText(money(firstGift), { x: 144, y: 340.5, size: 11, font: fBodyB, color: INK });
  }

  if (term !== 5 || oneTime) {
    page.drawRectangle({ x: 61.2, y: 287, width: 400, height: 17, color: WHITE });
    const tail = oneTime ? 'fulfill it faithfully.' : `fulfill it faithfully over the next ${termPhrase(term)}.`;
    page.drawText(tail, { x: 61.2, y: 291, size: 11, font: fBodyI, color: INK });
  }

  page.drawText(fit(String(pledge.donor_name || ''), fBodyB, 12, 500), { x: 43.2, y: 271.5, size: 12, font: fBodyB, color: INK });
  if (pledge.email) page.drawText(fit(String(pledge.email), fBody, 10, 245), { x: 43.2, y: 243, size: 10, font: fBody, color: INK });
  if (pledge.phone) page.drawText(fit(String(pledge.phone), fBody, 10, 245), { x: 319, y: 243, size: 10, font: fBody, color: INK });

  if (signaturePng) {
    try {
      const img = await pdf.embedPng(signaturePng);
      const maxW = 285, maxH = 23;
      const scale = Math.min(maxW / img.width, maxH / img.height);
      page.drawImage(img, { x: 100, y: 213, width: img.width * scale, height: img.height * scale });
    } catch (_) { /* a bad PNG shouldn't kill the card */ }
  } else if (pledge.signed_name) {
    page.drawText(fit(pledge.signed_name, fBody, 11, 280), { x: 100, y: 216, size: 11, font: fBody, color: INK });
  }

  page.drawText(longDate(when), { x: 420, y: 214, size: 10, font: fBody, color: INK });

  const how = pledge.source === 'online' ? 'Submitted online at pledge.shepherdchurch.co' : 'Recorded by Shepherd Church';
  page.drawText(`Ref ${pledge.ref_code || ''}  ·  ${how}  ·  ${longDate(when)}`, { x: 43.2, y: 186, size: 7, font: fBody, color: MUTED });

  return pdf.save();
}

function fit(text, font, size, maxWidth) {
  let t = text;
  while (t.length > 4 && font.widthOfTextAtSize(t, size) > maxWidth) t = t.slice(0, -1);
  return t === text ? t : t.trimEnd() + '…';
}
