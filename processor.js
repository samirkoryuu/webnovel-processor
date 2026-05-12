const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cheerio = require('cheerio');

const app = express();
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.get('/health', (req, res) => res.status(200).send('OK'));

// Extract __NEXT_DATA__ using regex only (cheerio truncates large scripts)
function extractNextData(rawHtml) {
    // If rawHtml is a JSON-wrapped string, unwrap it
    if (typeof rawHtml === 'string' && (rawHtml.trim().startsWith('{') || rawHtml.trim().startsWith('"'))) {
        try {
            const parsed = JSON.parse(rawHtml);
            if (parsed.content) rawHtml = parsed.content;
            else if (parsed.html) rawHtml = parsed.html;
            else if (typeof parsed === 'string') rawHtml = parsed;
        } catch(e) { /* not JSON, keep as is */ }
    }

    // Extract the entire script content using regex (no truncation)
    const regex = /<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i;
    const match = rawHtml.match(regex);
    if (!match || !match[1]) throw new Error('__NEXT_DATA__ script not found');

    const scriptContent = match[1];
    // Optional: log length to verify
    // console.log('Script content length:', scriptContent.length);
    return JSON.parse(scriptContent);
}

function extractBooksFromHTML(html, taskId) {
    const data = extractNextData(html);
    const props = data.props;
    if (!props) throw new Error('props missing');
    const initialState = props.initialState;
    if (!initialState) throw new Error('initialState missing');

    // Find userProfile and authorPageInfo – they may be at top level or inside entities
    let userProfile = initialState.userProfile;
    let authorPageInfo = initialState.authorPageInfo;
    if (!userProfile || !authorPageInfo) {
        // Fallback: search inside entities (structure may vary)
        if (initialState.entities) {
            if (!userProfile) userProfile = initialState.entities.userProfile;
            if (!authorPageInfo) authorPageInfo = initialState.entities.authorPageInfo;
        }
    }
    if (!userProfile) throw new Error('userProfile not found');
    if (!authorPageInfo) throw new Error('authorPageInfo not found');

    const userId = Object.keys(userProfile)[0];
    const profile = userProfile[userId];
    const base = profile.baseInfo;
    const books = authorPageInfo[userId]?.bookListItems || [];

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

    if (error || !tasks?.length) return;

    for (const task of tasks) {
        try {
            // Extract HTML from result (handles both JSONB object and string)
            let html = null;
            if (task.result && typeof task.result === 'object') {
                html = task.result.content || task.result.html;
            } else if (typeof task.result === 'string') {
                try {
                    const parsed = JSON.parse(task.result);
                    html = parsed.content || parsed.html;
                } catch(e) {
                    html = task.result;
                }
            }

            if (!html) {
                console.log(`⚠️ Task ${task.id}: no HTML content found`);
                await supabase.from('task_queue').update({ processed: true }).eq('id', task.id);
                continue;
            }

            const books = extractBooksFromHTML(html, task.id);
            if (books.length) {
                await upsertBooks(books);
                console.log(`✅ Task ${task.id}: processed ${books.length} books`);
            } else {
                console.log(`⚠️ Task ${task.id}: no books found`);
            }
            await supabase.from('task_queue').update({ processed: true }).eq('id', task.id);
        } catch (err) {
            console.error(`❌ Task ${task.id} failed:`, err.message);
            // Do NOT mark processed – retry later
        }
    }
}

setInterval(processCompletedTasks, 5000);
processCompletedTasks();

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Processor running on port ${PORT}`));
