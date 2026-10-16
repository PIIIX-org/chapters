// Multilingual retrieval with Elara's hybrid search (search/search.ts:268):
// Postgres FTS with the 'english' text-search config (drizzle/0002: fts =
// to_tsvector('english', path || frontmatter || body)) + bge-small-en-v1.5
// embeddings (search/embeddings.ts:40), fused by RRF.
//
// Corpus: 20 Persian notes, 20 English notes, 4 mixed Persian/English notes,
// neutral paths (concepts/fa-01, ...) so the path slug leaks no language.
// Queries with one known answer each, in two styles (natural question,
// keywords): 10 Persian targets, 10 English targets, 4 mixed, 3 cross-
// lingual, and 6 Arabic-script normalization pairs (ی/ي, ک/ك, ZWNJ, digits).
// For every query: rank of the answer in (a) the hybrid REST search the UI
// uses, (b) keyword-only (the exact FTS SQL of noteRows), (c) vector-only
// (the exact KNN SQL, query embedded with the same model inside the app
// container). hit@1/hit@5/MRR per group and retriever.
import type { Check, LabTest } from '../lib/context.ts'
import { lit, poll } from '../lib/portability.ts'

interface Doc {
  id: string
  lang: 'fa' | 'en' | 'mix'
  title: string
  body: string
}

const DOCS: Doc[] = [
  { id: 'fa-01', lang: 'fa', title: 'کوه دماوند', body: 'دماوند بلندترین قله ایران و بلندترین آتشفشان آسیا است. ارتفاع این کوه حدود ۵۶۱۰ متر است و در رشته‌کوه البرز قرار دارد. کوهنوردان معمولاً از جبهه جنوبی و روستای پلور صعود می‌کنند.' },
  { id: 'fa-02', lang: 'fa', title: 'تخت جمشید', body: 'تخت جمشید پایتخت تشریفاتی هخامنشیان بود که ساخت آن در زمان داریوش بزرگ آغاز شد. این مجموعه در نزدیکی شیراز در استان فارس قرار دارد و در سال ۳۳۰ پیش از میلاد به دست اسکندر به آتش کشیده شد.' },
  { id: 'fa-03', lang: 'fa', title: 'شاهنامه فردوسی', body: 'شاهنامه حماسه ملی ایران است که فردوسی توسی آن را در حدود سی سال سرود. این کتاب نزدیک به پنجاه هزار بیت دارد و داستان‌های رستم و سهراب و اسفندیار را روایت می‌کند.' },
  { id: 'fa-04', lang: 'fa', title: 'زعفران', body: 'زعفران گران‌ترین ادویه جهان است و بیش از نود درصد زعفران دنیا در خراسان تولید می‌شود. هر گل زعفران تنها سه کلاله سرخ دارد که باید با دست چیده شود.' },
  { id: 'fa-05', lang: 'fa', title: 'نوروز', body: 'نوروز جشن آغاز سال نو خورشیدی است که هم‌زمان با اعتدال بهاری برگزار می‌شود. چیدن سفره هفت‌سین و سیزده‌بدر از آیین‌های مهم نوروز هستند.' },
  { id: 'fa-06', lang: 'fa', title: 'قنات', body: 'قنات یک کانال زیرزمینی برای انتقال آب از سفره‌های زیرزمینی به سطح زمین است. قنات قصبه گناباد یکی از قدیمی‌ترین و عمیق‌ترین قنات‌های جهان است و چاه مادر آن بیش از سیصد متر عمق دارد.' },
  { id: 'fa-07', lang: 'fa', title: 'حافظ شیرازی', body: 'حافظ شاعر بزرگ قرن هشتم هجری است که غزل‌هایش در دیوان حافظ گردآوری شده است. آرامگاه او در حافظیه شیراز قرار دارد و بسیاری از ایرانیان با دیوان او فال می‌گیرند.' },
  { id: 'fa-08', lang: 'fa', title: 'دریای خزر', body: 'دریای خزر بزرگ‌ترین دریاچه جهان است و استان‌های گیلان، مازندران و گلستان در کرانه جنوبی آن قرار دارند. ماهی خاویار از مهم‌ترین منابع این دریاست.' },
  { id: 'fa-09', lang: 'fa', title: 'کویر لوت', body: 'کویر لوت در جنوب شرقی ایران قرار دارد و ماهواره‌ها گرم‌ترین دمای سطح زمین را در آن ثبت کرده‌اند که به حدود هفتاد درجه سانتی‌گراد می‌رسد. کلوت‌های شهداد از پدیده‌های دیدنی این کویر هستند.' },
  { id: 'fa-10', lang: 'fa', title: 'شب یلدا', body: 'شب یلدا طولانی‌ترین شب سال و آخرین شب پاییز است. ایرانیان در این شب دور هم جمع می‌شوند، انار و هندوانه می‌خورند و دیوان حافظ می‌خوانند.' },
  { id: 'fa-11', lang: 'fa', title: 'پسته رفسنجان', body: 'رفسنجان در استان کرمان بزرگ‌ترین مرکز تولید پسته ایران است. پسته اکبری و احمدآقایی از ارقام معروف این منطقه هستند.' },
  { id: 'fa-12', lang: 'fa', title: 'برج آزادی', body: 'برج آزادی نماد شهر تهران است که در سال ۱۳۴۹ خورشیدی به طراحی حسین امانت ساخته شد. این برج در میدان آزادی و در غرب تهران قرار دارد.' },
  { id: 'fa-13', lang: 'fa', title: 'فرش کاشان', body: 'فرش دستباف کاشان به خاطر گره‌های ریز و نقشه‌های ترنج‌دار شهرت دارد. کاشان همچنین به گلاب‌گیری قمصر معروف است.' },
  { id: 'fa-14', lang: 'fa', title: 'بادگیر یزد', body: 'بادگیرها برج‌هایی برای خنک کردن خانه‌ها در اقلیم گرم و خشک هستند. باغ دولت‌آباد یزد بلندترین بادگیر جهان را دارد.' },
  { id: 'fa-15', lang: 'fa', title: 'چای لاهیجان', body: 'کاشت چای در ایران با کاشف‌السلطنه آغاز شد که بذر چای را از هند به لاهیجان آورد. آرامگاه او در لاهیجان قرار دارد.' },
  { id: 'fa-16', lang: 'fa', title: 'سی‌وسه‌پل', body: 'سی‌وسه‌پل یا پل الله‌وردی‌خان روی زاینده‌رود در اصفهان ساخته شده و سی و سه دهانه دارد. این پل در دوره شاه عباس یکم ساخته شد.' },
  { id: 'fa-17', lang: 'fa', title: 'خط نستعلیق', body: 'نستعلیق زیباترین خط خوشنویسی ایرانی شمرده می‌شود و میرعلی تبریزی را واضع آن می‌دانند. میرعماد حسنی از استادان بزرگ این خط است.' },
  { id: 'fa-18', lang: 'fa', title: 'مسجد شیخ لطف‌الله', body: 'مسجد شیخ لطف‌الله در ضلع شرقی میدان نقش جهان اصفهان قرار دارد. گنبد این مسجد در طول روز تغییر رنگ می‌دهد و مناره ندارد.' },
  { id: 'fa-19', lang: 'fa', title: 'ابن سینا', body: 'ابن سینا پزشک و فیلسوف ایرانی است که کتاب قانون در طب را نوشت. این کتاب قرن‌ها در دانشگاه‌های اروپا تدریس می‌شد.' },
  { id: 'fa-20', lang: 'fa', title: 'خلیج فارس', body: 'خلیج فارس پهنه آبی میان ایران و شبه‌جزیره عربستان است. تنگه هرمز این خلیج را به دریای عمان متصل می‌کند و بخش بزرگی از نفت جهان از آن عبور می‌کند.' },
  { id: 'en-01', lang: 'en', title: 'Mount Everest', body: 'Mount Everest is the highest mountain above sea level, with an official height of 8,849 metres measured in 2020. It sits on the border between Nepal and the Tibet Autonomous Region.' },
  { id: 'en-02', lang: 'en', title: 'Great Barrier Reef', body: 'The Great Barrier Reef off Queensland, Australia, is the largest coral reef system in the world, stretching over 2,300 kilometres. Rising sea temperatures cause mass coral bleaching events.' },
  { id: 'en-03', lang: 'en', title: 'Photosynthesis', body: 'Photosynthesis converts light energy into chemical energy. Chlorophyll in the chloroplasts absorbs mostly red and blue light, and the process releases oxygen as a by-product.' },
  { id: 'en-04', lang: 'en', title: 'TCP handshake', body: 'A TCP connection is opened with a three-way handshake: SYN, SYN-ACK, ACK. Closing uses FIN segments, and the TIME_WAIT state protects against delayed packets.' },
  { id: 'en-05', lang: 'en', title: 'Rust borrow checker', body: "Rust's borrow checker enforces that a value has either one mutable reference or any number of immutable references at a time, which prevents data races at compile time." },
  { id: 'en-06', lang: 'en', title: 'Marie Curie', body: 'Marie Curie was the first person to win Nobel Prizes in two different sciences: physics in 1903 and chemistry in 1911. She discovered polonium and radium.' },
  { id: 'en-07', lang: 'en', title: 'Amazon River', body: 'The Amazon River carries more water than any other river, discharging about 209,000 cubic metres per second into the Atlantic Ocean.' },
  { id: 'en-08', lang: 'en', title: 'Penicillin', body: "Alexander Fleming discovered penicillin in 1928 after noticing that a Penicillium mould killed bacteria on a culture plate at St Mary's Hospital in London." },
  { id: 'en-09', lang: 'en', title: 'Apollo 11', body: 'Apollo 11 landed on the Moon on 20 July 1969. Neil Armstrong and Buzz Aldrin walked on the lunar surface while Michael Collins orbited in the command module.' },
  { id: 'en-10', lang: 'en', title: 'Mitochondria', body: "Mitochondria produce most of the cell's ATP through oxidative phosphorylation and carry their own circular DNA inherited from the mother." },
  { id: 'en-11', lang: 'en', title: 'Hamlet', body: "Hamlet, Prince of Denmark, is a tragedy by William Shakespeare written around 1600. It contains the soliloquy 'To be, or not to be'." },
  { id: 'en-12', lang: 'en', title: 'Sahara', body: 'The Sahara is the largest hot desert, covering about 9.2 million square kilometres of North Africa.' },
  { id: 'en-13', lang: 'en', title: 'Bitcoin proof of work', body: 'Bitcoin uses proof of work: miners repeatedly hash block headers with SHA-256 until the hash falls below the difficulty target.' },
  { id: 'en-14', lang: 'en', title: 'Eiffel Tower', body: "The Eiffel Tower in Paris was completed in 1889 for the World's Fair and is 330 metres tall including antennas." },
  { id: 'en-15', lang: 'en', title: 'Kubernetes pods', body: 'In Kubernetes, a pod is the smallest deployable unit and groups one or more containers that share network and storage.' },
  { id: 'en-16', lang: 'en', title: 'Black holes', body: "A black hole's event horizon is the boundary beyond which nothing, not even light, can escape. Its radius is the Schwarzschild radius." },
  { id: 'en-17', lang: 'en', title: 'Coffee', body: 'Coffee originated in Ethiopia; legend says a goat herder named Kaldi noticed his goats became energetic after eating coffee berries.' },
  { id: 'en-18', lang: 'en', title: 'Great Wall', body: 'The Great Wall of China is a series of fortifications built over centuries, with the best-preserved sections from the Ming dynasty.' },
  { id: 'en-19', lang: 'en', title: 'mRNA vaccines', body: 'mRNA vaccines deliver messenger RNA in lipid nanoparticles so cells produce a viral spike protein that trains the immune system.' },
  { id: 'en-20', lang: 'en', title: 'Python GIL', body: "CPython's global interpreter lock allows only one thread to execute Python bytecode at a time, limiting CPU-bound multithreading." },
  { id: 'mix-01', lang: 'mix', title: 'پایگاه داده PostgreSQL', body: 'برای جستجوی متنی در PostgreSQL از ستون tsvector و ایندکس GIN استفاده می‌کنیم. افزونه pgvector امکان جستجوی برداری با فاصله کسینوسی را فراهم می‌کند.' },
  { id: 'mix-02', lang: 'mix', title: 'استقرار با Docker Compose', body: 'فایل docker-compose.yml سرویس‌های app و db را تعریف می‌کند. برای پشتیبان‌گیری از volume باید از دستور pg_dump و tar استفاده کرد.' },
  { id: 'mix-03', lang: 'mix', title: 'مدل زبانی و embedding', body: 'مدل bge-small-en برای زبان انگلیسی آموزش دیده است و برای متن فارسی بردارهای ضعیفی تولید می‌کند. برای فارسی بهتر است از یک مدل multilingual مانند multilingual-e5 استفاده شود.' },
  { id: 'mix-04', lang: 'mix', title: 'Kubernetes در تولید', body: 'در محیط production هر pod باید readinessProbe و livenessProbe داشته باشد. ما از Helm برای مدیریت نسخه‌های استقرار روی کلاستر Kubernetes استفاده می‌کنیم.' },
]

type Group = 'fa' | 'en' | 'mix' | 'cross' | 'norm-base' | 'norm-variant'
interface Query {
  q: string
  target: string
  group: Group
  style: 'question' | 'keywords'
  /** For normalization pairs: what differs from the base spelling. */
  variant?: string
}

const QUERIES: Query[] = [
  // Persian: question + keywords for fa-01..fa-10
  ...(
    [
      ['fa-01', 'بلندترین کوه ایران کدام است؟', 'ارتفاع دماوند'],
      ['fa-02', 'چه کسی تخت جمشید را آتش زد؟', 'تخت جمشید اسکندر'],
      ['fa-03', 'شاهنامه چند بیت دارد؟', 'فردوسی رستم سهراب'],
      ['fa-04', 'بیشتر زعفران جهان کجا تولید می‌شود؟', 'زعفران خراسان'],
      ['fa-05', 'سفره هفت سین برای کدام جشن چیده می‌شود؟', 'نوروز هفت‌سین'],
      ['fa-06', 'عمیق‌ترین قنات جهان کجاست؟', 'قنات گناباد'],
      ['fa-07', 'آرامگاه حافظ در کدام شهر است؟', 'حافظیه شیراز'],
      ['fa-08', 'بزرگ‌ترین دریاچه دنیا کدام است؟', 'خزر خاویار'],
      ['fa-09', 'گرم‌ترین نقطه زمین کجاست؟', 'کویر لوت کلوت'],
      ['fa-10', 'طولانی‌ترین شب سال چه نام دارد؟', 'یلدا انار هندوانه'],
    ] as const
  ).flatMap(([target, question, keywords]): Query[] => [
    { q: question, target, group: 'fa', style: 'question' },
    { q: keywords, target, group: 'fa', style: 'keywords' },
  ]),
  ...(
    [
      ['en-01', 'What is the tallest mountain on Earth?', 'Everest height'],
      ['en-02', 'Where is the biggest coral reef?', 'coral bleaching Queensland'],
      ['en-03', 'How do plants turn sunlight into food?', 'chlorophyll chloroplast oxygen'],
      ['en-04', 'How does a TCP connection get established?', 'SYN ACK handshake'],
      ['en-05', 'How does Rust prevent data races?', 'borrow checker mutable reference'],
      ['en-06', 'Who won Nobel prizes in both physics and chemistry?', 'polonium radium Curie'],
      ['en-07', 'Which river has the largest discharge?', 'Amazon discharge Atlantic'],
      ['en-08', 'Who discovered the first antibiotic?', 'Fleming penicillin 1928'],
      ['en-09', 'When did humans first land on the moon?', 'Apollo 11 Armstrong Aldrin'],
      ['en-10', 'Which organelle makes ATP?', 'mitochondria oxidative phosphorylation'],
    ] as const
  ).flatMap(([target, question, keywords]): Query[] => [
    { q: question, target, group: 'en', style: 'question' },
    { q: keywords, target, group: 'en', style: 'keywords' },
  ]),
  { q: 'جستجوی برداری با pgvector', target: 'mix-01', group: 'mix', style: 'keywords' },
  { q: 'پشتیبان‌گیری از volume در Docker', target: 'mix-02', group: 'mix', style: 'keywords' },
  { q: 'مدل multilingual برای فارسی', target: 'mix-03', group: 'mix', style: 'keywords' },
  { q: 'readinessProbe در Kubernetes', target: 'mix-04', group: 'mix', style: 'keywords' },
  { q: 'height of Mount Damavand', target: 'fa-01', group: 'cross', style: 'question' },
  { q: 'Persian new year at the spring equinox', target: 'fa-05', group: 'cross', style: 'question' },
  { q: 'ارتفاع قله اورست', target: 'en-01', group: 'cross', style: 'question' },
  // Normalization pairs: base spelling as stored, then the variant users type.
  ...(
    [
      ['fa-09', 'کویر لوت', 'كوير لوت', 'Arabic kaf ك + Arabic yeh ي'],
      ['fa-10', 'یلدا', 'يلدا', 'Arabic yeh ي'],
      ['fa-13', 'فرش کاشان', 'فرش كاشان', 'Arabic kaf ك'],
      ['fa-16', 'سی‌وسه‌پل', 'سیوسه پل', 'ZWNJ dropped / space'],
      ['fa-18', 'مسجد شیخ لطف‌الله', 'مسجد شیخ لطف الله', 'ZWNJ -> space'],
      ['fa-12', 'برج آزادی ۱۳۴۹', 'برج آزادی 1349', 'Persian digits -> ASCII digits'],
    ] as const
  ).flatMap(([target, baseQ, variantQ, variant]): Query[] => [
    { q: baseQ, target, group: 'norm-base', style: 'keywords', variant },
    { q: variantQ, target, group: 'norm-variant', style: 'keywords', variant },
  ]),
]

/** Embeds queries with the server's own model call (search/embeddings.ts:38-51) inside the app container. */
const EMBED_JS = `
import { readFileSync } from 'node:fs'
import { pipeline } from '@huggingface/transformers'
const pipe = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5')
const qs = JSON.parse(readFileSync(0, 'utf8'))
const tok = pipe.tokenizer
const unk = tok.unk_token_id ?? tok.model?.tokens_to_ids?.get?.('[UNK]')
const out = []
for (const q of qs) {
  const o = await pipe([q], { pooling: 'mean', normalize: true })
  let ids = []
  try { ids = Array.from(tok.encode(q)) } catch {}
  out.push({ vec: o.tolist()[0], tokens: ids.length, unk: ids.filter((i) => i === unk).length, pieces: ids.slice(0, 24).map((i) => tok.decode([i])) })
}
process.stdout.write(JSON.stringify(out))
`

interface Ranked {
  q: string
  target: string
  group: Group
  style: string
  variant?: string
  hybrid: number | null
  keyword: number | null
  vector: number | null
  keywordCandidates: number
  tokens: number
  unk: number
  pieces: string[]
  top3: string[]
}

function metrics(rows: Ranked[], key: 'hybrid' | 'keyword' | 'vector') {
  const n = rows.length
  if (n === 0) return { n: 0, hit1: null, hit5: null, mrr: null }
  const r = rows.map((x) => x[key])
  const hit1 = r.filter((x) => x === 1).length / n
  const hit5 = r.filter((x) => x !== null && x <= 5).length / n
  const mrr = r.reduce((s: number, x) => s + (x ? 1 / x : 0), 0) / n
  return { n, hit1: Number(hit1.toFixed(3)), hit5: Number(hit5.toFixed(3)), mrr: Number(mrr.toFixed(3)) }
}

const test: LabTest = {
  name: 'multilingual-search',
  description: '20 fa + 20 en + 4 mixed notes; hit@1/hit@5/MRR for hybrid vs keyword-only vs vector-only; Arabic-script normalization pairs.',
  async run(ctx) {
    const checks: Check[] = []
    const mcp = ctx.mcp('adminAccount')
    const admin = ctx.rest('admin')
    // The same corpus is written to TRIALS vaults. Content is identical; only the
    // auto-added frontmatter `timestamp` (store.ts:225-229), which is part of the
    // embedded text (embedding-queue.ts:77), differs — so trial-to-trial rank
    // changes measure how much ranking depends on noise rather than content.
    const trials = Number(process.env.LAB_ML_TRIALS ?? 3)
    const vaultIds: string[] = []
    const failures: string[] = []
    for (let t = 0; t < trials; t++) {
      const vault = await ctx.createVault('admin', ctx.uniq(`ml-t${t + 1}`))
      vaultIds.push(vault.id)
      for (const d of DOCS) {
        const r = await mcp.call('create_note', {
          vaultId: vault.id,
          path: `concepts/${d.id}`,
          frontmatter: { type: 'concepts', title: d.title, tags: [d.lang] },
          body: `# ${d.title}\n\n${d.body}\n`,
        })
        if (!r.ok) failures.push(`t${t + 1} ${d.id}: ${r.text.slice(0, 120)}`)
      }
    }
    const V = vaultIds[0]!
    checks.push({ name: 'corpus created', expected: `${DOCS.length} notes x ${trials} vaults`, actual: `${DOCS.length * trials - failures.length}`, ok: failures.length === 0, severity: 'high', detail: failures })

    const t0 = performance.now()
    const embedded = await poll(async () => {
      const rows = await ctx.docker.psqlRows<{ missing: number }>(
        `select count(*)::int as missing from notes where vault_id in (${vaultIds.map(lit).join(',')}) and embedding is null`,
      )
      return rows[0]?.missing === 0 ? true : undefined
    }, 15 * 60_000, 2_000)
    const embedMs = Math.round(performance.now() - t0)
    checks.push({ name: 'all notes embedded', expected: 'embedding not null for every note', actual: embedded ? `yes after ${embedMs} ms` : `timed out after ${embedMs} ms`, ok: Boolean(embedded), severity: 'high' })

    // Query vectors from the same model inside the app container.
    const emb = await ctx.docker.appExec(['node', '--input-type=module', '-e', EMBED_JS], JSON.stringify(QUERIES.map((q) => q.q)))
    let vectors: Array<{ vec: number[]; tokens: number; unk: number; pieces: string[] }> = []
    try {
      vectors = JSON.parse(emb.stdout) as typeof vectors
    } catch {
      vectors = []
    }
    checks.push({
      name: 'query embeddings computed in-container with the server model',
      expected: `${QUERIES.length} vectors`,
      actual: `${vectors.length} (exit ${emb.code}) ${emb.stderr.slice(-200)}`,
      ok: vectors.length === QUERIES.length ? true : null,
      severity: 'info',
    })

    const pathOf = (id: string) => `concepts/${id}`
    const rankAll = async (vaultId: string): Promise<Ranked[]> => {
      const out: Ranked[] = []
      for (const [i, q] of QUERIES.entries()) {
        const hybrid = await admin.get<Array<{ path: string; resourceType: string }>>(`/api/vaults/${vaultId}/search?q=${encodeURIComponent(q.q)}&limit=30`)
        const hybridPaths = Array.isArray(hybrid.json) ? hybrid.json.filter((r) => r.resourceType === 'note').map((r) => r.path) : []
        // Exactly noteRows(..., 'keyword') from search/search.ts:102-117 (minus ts_headline).
        const kw = await ctx.docker.psqlRows<{ path: string }>(
          `select path from notes where vault_id = '${vaultId}' and deleted_at is null and fts @@ websearch_to_tsquery('english', ${lit(q.q)}) order by ts_rank(fts, websearch_to_tsquery('english', ${lit(q.q)})) desc limit 30`,
        )
        const v = vectors[i]
        // Exactly noteRows(..., 'semantic') from search/search.ts:118-127.
        const vec = v
          ? await ctx.docker.psqlRows<{ path: string }>(
              `select path from notes where vault_id = '${vaultId}' and deleted_at is null and embedding is not null order by embedding <=> '${JSON.stringify(v.vec)}'::vector limit 30`,
            )
          : []
        const rank = (paths: string[]) => {
          const at = paths.indexOf(pathOf(q.target))
          return at < 0 ? null : at + 1
        }
        out.push({
          q: q.q,
          target: q.target,
          group: q.group,
          style: q.style,
          variant: q.variant,
          hybrid: rank(hybridPaths),
          keyword: rank(kw.map((r) => r.path)),
          vector: v ? rank(vec.map((r) => r.path)) : null,
          keywordCandidates: kw.length,
          tokens: v?.tokens ?? 0,
          unk: v?.unk ?? 0,
          pieces: v?.pieces ?? [],
          top3: hybridPaths.slice(0, 3),
        })
      }
      return out
    }
    const perTrial: Ranked[][] = []
    for (const id of vaultIds) perTrial.push(await rankAll(id))
    const results = perTrial[0]!
    const trialSummary = perTrial.map((rs, t) => {
      const g = (grp: Group, k: 'hybrid' | 'keyword' | 'vector') => metrics(rs.filter((r) => r.group === grp), k)
      return { trial: t + 1, faHybrid: g('fa', 'hybrid'), faVector: g('fa', 'vector'), faKeyword: g('fa', 'keyword'), enHybrid: g('en', 'hybrid'), enVector: g('en', 'vector'), normVariantHybrid: g('norm-variant', 'hybrid') }
    })
    const rankFlips = (grp: Group, k: 'hybrid' | 'vector') =>
      results.filter((r, i) => r.group === grp && perTrial.some((rs) => rs[i]![k] !== r[k])).length
    const stability = {
      faVectorQueriesWhoseRankChanged: rankFlips('fa', 'vector'),
      faHybridQueriesWhoseRankChanged: rankFlips('fa', 'hybrid'),
      enVectorQueriesWhoseRankChanged: rankFlips('en', 'vector'),
      enHybridQueriesWhoseRankChanged: rankFlips('en', 'hybrid'),
    }
    checks.push({
      name: 'ranking is stable across identical copies of the corpus',
      expected: 'same rank for every query in every trial (content identical; only auto timestamps differ)',
      actual: `${trials} trials; queries whose rank changed — fa vector ${stability.faVectorQueriesWhoseRankChanged}/20, fa hybrid ${stability.faHybridQueriesWhoseRankChanged}/20, en vector ${stability.enVectorQueriesWhoseRankChanged}/20, en hybrid ${stability.enHybridQueriesWhoseRankChanged}/20`,
      ok: trials < 2 ? null : stability.faHybridQueriesWhoseRankChanged + stability.enHybridQueriesWhoseRankChanged === 0,
      severity: 'medium',
      detail: trialSummary,
    })

    const groups: Group[] = ['fa', 'en', 'mix', 'cross', 'norm-base', 'norm-variant']
    const table: Array<Record<string, unknown>> = []
    for (const g of groups) {
      for (const style of ['question', 'keywords', 'all'] as const) {
        const rows = results.filter((r) => r.group === g && (style === 'all' || r.style === style))
        if (rows.length === 0 || (style !== 'all' && rows.length === results.filter((r) => r.group === g).length)) continue
        table.push({
          group: g,
          style,
          n: rows.length,
          hybrid: metrics(rows, 'hybrid'),
          keyword: metrics(rows, 'keyword'),
          vector: metrics(rows, 'vector'),
          meanUnkRatio: Number((rows.reduce((s, r) => s + (r.tokens ? r.unk / r.tokens : 0), 0) / rows.length).toFixed(3)),
        })
      }
    }
    const m = (g: Group, k: 'hybrid' | 'keyword' | 'vector') => metrics(results.filter((r) => r.group === g), k)
    const fa = m('fa', 'hybrid')
    const en = m('en', 'hybrid')
    checks.push({
      name: 'Persian retrieval on par with English (hybrid hit@1)',
      expected: `fa hit@1 within 0.2 of en (${en.hit1})`,
      actual: `fa hit@1 ${fa.hit1}, hit@5 ${fa.hit5}, MRR ${fa.mrr}; en hit@1 ${en.hit1}, hit@5 ${en.hit5}, MRR ${en.mrr}`,
      ok: fa.hit1 !== null && en.hit1 !== null && fa.hit1 >= en.hit1 - 0.2,
      severity: 'medium',
    })
    const faVec = m('fa', 'vector')
    const enVec = m('en', 'vector')
    checks.push({
      name: 'vector retriever ranks Persian answers first as often as English (bge-small-en)',
      expected: `fa vector hit@1 within 0.2 of en vector (${enVec.hit1})`,
      actual: `fa vector hit@1 ${faVec.hit1}, hit@5 ${faVec.hit5}; en vector hit@1 ${enVec.hit1}, hit@5 ${enVec.hit5}`,
      ok: faVec.hit1 !== null && enVec.hit1 !== null && faVec.hit1 >= enVec.hit1 - 0.2,
      severity: 'medium',
    })
    const pairs = results
      .filter((r) => r.group === 'norm-variant')
      .map((v) => {
        const b = results.find((r) => r.group === 'norm-base' && r.target === v.target && r.variant === v.variant)!
        return { variant: v.variant, base: b.q, typed: v.q, target: v.target, base_hybrid: b.hybrid, variant_hybrid: v.hybrid, base_keyword: b.keyword, variant_keyword: v.keyword, base_vector: b.vector, variant_vector: v.vector }
      })
    for (const p of pairs) {
      checks.push({
        name: `normalization: ${p.variant} ("${p.typed}" vs stored "${p.base}")`,
        expected: 'variant finds the note at the same hybrid rank as the stored spelling',
        actual: `hybrid ${p.base_hybrid} -> ${p.variant_hybrid}; keyword ${p.base_keyword} -> ${p.variant_keyword}; vector ${p.base_vector} -> ${p.variant_vector}`,
        ok: p.variant_hybrid !== null && p.base_hybrid !== null && p.variant_hybrid <= p.base_hybrid,
        severity: 'medium',
      })
    }
    const mix = m('mix', 'hybrid')
    checks.push({ name: 'mixed Persian/English queries', expected: 'hit@5 = 1', actual: `hit@1 ${mix.hit1}, hit@5 ${mix.hit5}`, ok: mix.hit5 === 1, severity: 'low' })
    // Cross-lingual has no expectation (English-only model, no translation):
    // reported in the summary and data.metrics, not as a check.
    const cross = m('cross', 'hybrid')

    // Ground truth: how the 'english' FTS config tokenizes Persian; embedding collapse.
    const tsDebug = await ctx.docker.psqlRows<{ alias: string; token: string; lexemes: string[] | null }>(
      `select alias, token, lexemes from ts_debug('english', ${lit('می‌خواهم سی‌وسه‌پل كوير کویر يلدا یلدا ۱۳۴۹ 1349 PostgreSQL')})`,
    )
    const similarity = await ctx.docker.psqlRows<{ pair: string; avg_sim: number; min_sim: number }>(
      `select a.tags || '-' || b.tags as pair, round(avg(1 - (a.embedding <=> b.embedding))::numeric, 3)::float as avg_sim, round(min(1 - (a.embedding <=> b.embedding))::numeric, 3)::float as min_sim
       from (select id, embedding, frontmatter->'tags'->>0 as tags from notes where vault_id = '${V}') a
       join (select id, embedding, frontmatter->'tags'->>0 as tags from notes where vault_id = '${V}') b on a.id < b.id
       group by 1 order by 1`,
    )
    // semantic-edges.ts:16-56 kNN is not scoped to a vault, so with identical
    // corpora in several vaults edges also land on the twin notes: count both.
    const inTrials = vaultIds.map(lit).join(',')
    const edgeCount = (lang: string, crossVault: boolean) =>
      ctx.docker.psql(
        `select count(*) from semantic_edges e join notes a on a.id = e.node_a_id join notes b on b.id = e.node_b_id
         where a.vault_id in (${inTrials}) and b.vault_id in (${inTrials}) and a.vault_id ${crossVault ? '<>' : '='} b.vault_id
           and a.frontmatter->'tags'->>0 = '${lang}' and b.frontmatter->'tags'->>0 = '${lang}'`,
      )
    const faEdges = await edgeCount('fa', false)
    const enEdges = await edgeCount('en', false)
    const faCrossVaultEdges = await edgeCount('fa', true)
    const enCrossVaultEdges = await edgeCount('en', true)
    const faSim = similarity.find((s) => s.pair === 'fa-fa')
    const enSim = similarity.find((s) => s.pair === 'en-en')
    checks.push({
      name: 'Persian embeddings stay distinguishable (no collapse)',
      expected: 'mean pairwise cosine among unrelated fa notes close to en-en',
      actual: `fa-fa avg ${faSim?.avg_sim} (min ${faSim?.min_sim}), en-en avg ${enSim?.avg_sim} (min ${enSim?.min_sim}); semantic edges (threshold 0.75) fa-fa same-vault ${faEdges} / cross-vault ${faCrossVaultEdges}, en-en same-vault ${enEdges} / cross-vault ${enCrossVaultEdges}`,
      ok: faSim && enSim ? faSim.avg_sim - enSim.avg_sim < 0.15 : null,
      severity: 'medium',
    })

    return {
      summary:
        `Hybrid hit@1/hit@5/MRR — fa ${fa.hit1}/${fa.hit5}/${fa.mrr}, en ${en.hit1}/${en.hit5}/${en.mrr}, mixed ${mix.hit1}/${mix.hit5}, cross ${cross.hit5}. ` +
        `Vector-only fa ${faVec.hit1}/${faVec.hit5} vs en ${enVec.hit1}/${enVec.hit5}; keyword-only fa ${m('fa', 'keyword').hit1}/${m('fa', 'keyword').hit5} vs en ${m('en', 'keyword').hit1}/${m('en', 'keyword').hit5}. ` +
        `Normalization pairs where the variant lost rank: ${pairs.filter((p) => p.variant_hybrid === null || (p.base_hybrid !== null && p.variant_hybrid > p.base_hybrid)).length}/${pairs.length}. ` +
        `fa-fa mean cosine ${faSim?.avg_sim} vs en-en ${enSim?.avg_sim}. ` +
        `Across ${trials} identical corpora fa hybrid hit@1 = ${trialSummary.map((t) => t.faHybrid.hit1).join('/')}, fa vector hit@1 = ${trialSummary.map((t) => t.faVector.hit1).join('/')}, en hybrid hit@1 = ${trialSummary.map((t) => t.enHybrid.hit1).join('/')}.`,
      checks,
      data: {
        vaultIds,
        embedMs,
        metrics: table,
        trialSummary,
        stability,
        normalizationPairs: pairs,
        perQuery: results,
        perTrialRanks: perTrial.map((rs) => rs.map((r) => ({ q: r.q, hybrid: r.hybrid, vector: r.vector, keyword: r.keyword }))),
        tsDebug,
        similarity,
        semanticEdges: { faFaSameVault: Number(faEdges), enEnSameVault: Number(enEdges), faFaCrossVault: Number(faCrossVaultEdges), enEnCrossVault: Number(enCrossVaultEdges) },
        embedStderr: emb.stderr.slice(-1000),
      },
    }
  },
}
export default test
