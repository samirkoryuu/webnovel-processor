const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cheerio = require('cheerio');

const app = express();
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.get('/health', (req, res) => res.status(200).send('OK'));

// Safely extract __NEXT_DATA__ JSON from HTML (escaped or raw)
function extractNextData(htmlOrEscaped) {
    let rawHtml = htmlOrEscaped;
    // If it looks like a JSON-escaped string (starts with quotes and has \")
    if (typeof rawHtml === 'string' && (rawHtml.startsWith('"') || rawHtml.includes('\\"'))) {
        try {
            rawHtml = JSON.parse(rawHtml); // unescape
        } catch(e) { /* not valid JSON, keep as is */ }
    }
    
    // Method 1: use cheerio to find the script tag
    try {
        const $ = cheerio.load(rawHtml);
        const script = $('#__NEXT_DATA__').html();
        if (script) return JSON.parse(script);
    } catch(e) { console.log('Cheerio failed, trying regex...'); }
    
    // Method 2: regex fallback (more robust for malformed HTML)
    const regex = /<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i;
    const match = rawHtml.match(regex);
    if (match && match[1]) {
        return JSON.parse(match[1]);
    }
    throw new Error('__NEXT_DATA__ not found');
}

function extractBooksFromHTML(html, taskId) {
    const data = extractNextData(html);
    const props = data.props.initialState;
    const userId = Object.keys(props.userProfile)[0];
    const profile = props.userProfile[userId];
    const base = profile.baseInfo;
    const books = props.authorPageInfo?.[userId]?.bookListItems || [];

    const penname = base.realName;
    const country = base.countryName || null;

    return books.map(book => ({
        penname,
        country,
        book: book.bookName,
        genre: book.categoryName || null,
        collections: book.collectionNum || 0,
        chapters: book.totalChapterNum || 0,
        views: 0,
        power_ranking: null,
        task_id: taskId,
        created_at: new Date().toISOString(),
    }));
}

async function upsertBooks(books) {
    for (const book of books) {
        const { error } = await supabase
            .from('recent_findings')
            .upsert(book, { onConflict: 'penname, book' });
        if (error) console.error('Upsert error:', error.message);
    }
}

async function processCompletedTasks() {
    const { data: tasks, error } = await supabase
        .from('task_queue')
        .select('id, result')
        .eq('status', 'completed')
        .eq('processed', false)
        .order('id', { ascending: true })
        .limit(10);

    if (error) {
        console.error('Fetch error:', error.message);
        return;
    }
    if (!tasks || tasks.length === 0) return;

    for (const task of tasks) {
        try {
            const books = extractBooksFromHTML(task.result, task.id);
            if (books.length) {
                await upsertBooks(books);
                console.log(`✅ Task ${task.id}: processed ${books.length} books`);
            } else {
                console.log(`⚠️ Task ${task.id}: no books found`);
            }
            await supabase
                .from('task_queue')
                .update({ processed: true })
                .eq('id', task.id);
        } catch (err) {
            console.error(`❌ Task ${task.id} failed:`, err.message);
            // Do NOT mark as processed – will retry
        }
    }
}

setInterval(processCompletedTasks, 5000);
processCompletedTasks();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Processor running on port ${PORT}`));
