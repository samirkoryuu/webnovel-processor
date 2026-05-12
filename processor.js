const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cheerio = require('cheerio');

const app = express();
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.get('/health', (req, res) => res.status(200).send('OK'));

// Extract __NEXT_DATA__ from HTML (with fallbacks)
function extractNextData(rawHtml) {
    // If rawHtml is a string that looks like a JSON object, parse it first
    if (typeof rawHtml === 'string' && (rawHtml.trim().startsWith('{') || rawHtml.trim().startsWith('"'))) {
        try {
            const parsed = JSON.parse(rawHtml);
            if (parsed.content) rawHtml = parsed.content;
            else if (parsed.html) rawHtml = parsed.html;
            else if (typeof parsed === 'string') rawHtml = parsed;
        } catch(e) {}
    }

    // Use cheerio to find __NEXT_DATA__
    try {
        const $ = cheerio.load(rawHtml);
        const script = $('#__NEXT_DATA__').html();
        if (script) return JSON.parse(script);
    } catch(e) { /* fall through to regex */ }

    // Regex fallback
    const regex = /<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i;
    const match = rawHtml.match(regex);
    if (match && match[1]) return JSON.parse(match[1]);

    throw new Error('__NEXT_DATA__ not found');
}

function extractBooksFromHTML(html, taskId) {
    const data = extractNextData(html);
    const props = data.props.initialState;
    const userId = Object.keys(props.userProfile)[0];
    const profile = props.userProfile[userId];
    const base = profile.baseInfo;
    const books = props.authorPageInfo?.[userId]?.bookListItems || [];

    return books.map(book => ({
        penname: base.realName,
        country: base.countryName || null,
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
            // Extract HTML from result – result can be object or string
            let html = null;
            if (task.result && typeof task.result === 'object') {
                html = task.result.content || task.result.html || null;
            } else if (typeof task.result === 'string') {
                // Might be a JSON string or plain HTML
                try {
                    const parsed = JSON.parse(task.result);
                    html = parsed.content || parsed.html || null;
                } catch(e) {
                    // Not JSON, treat as raw HTML
                    html = task.result;
                }
            }

            if (!html) {
                console.log(`⚠️ Task ${task.id}: no HTML content found, marking as processed`);
                await supabase.from('task_queue').update({ processed: true }).eq('id', task.id);
                continue;
            }

            const books = extractBooksFromHTML(html, task.id);
            if (books.length) {
                await upsertBooks(books);
                console.log(`✅ Task ${task.id}: processed ${books.length} books`);
            } else {
                console.log(`⚠️ Task ${task.id}: HTML parsed but no books found`);
            }
            await supabase.from('task_queue').update({ processed: true }).eq('id', task.id);
        } catch (err) {
            console.error(`❌ Task ${task.id} failed:`, err.message);
            // Do NOT mark processed – will retry
        }
    }
}

// Run every 5 seconds
setInterval(processCompletedTasks, 5000);
processCompletedTasks();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Processor running on port ${PORT}`));
