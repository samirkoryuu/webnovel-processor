const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cheerio = require('cheerio');

const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

app.get('/health', (req, res) => res.status(200).send('OK'));

function extractNextData(rawHtml) {
    console.log('extractNextData called, HTML length:', rawHtml?.length);
    console.log('First 300 chars:', rawHtml?.substring(0, 300));
    
    // If rawHtml is a string that looks like JSON object, parse it first
    if (typeof rawHtml === 'string' && (rawHtml.trim().startsWith('{') || rawHtml.trim().startsWith('"'))) {
        try {
            const parsed = JSON.parse(rawHtml);
            if (parsed.content) rawHtml = parsed.content;
            else if (parsed.html) rawHtml = parsed.html;
            else if (typeof parsed === 'string') rawHtml = parsed;
        } catch(e) { console.log('Failed to parse top-level JSON:', e.message); }
    }

    // Use cheerio to find __NEXT_DATA__
    try {
        const $ = cheerio.load(rawHtml);
        const script = $('#__NEXT_DATA__').html();
        if (script) {
            console.log('Found __NEXT_DATA__ via cheerio, length:', script.length);
            return JSON.parse(script);
        }
    } catch(e) { console.log('Cheerio failed:', e.message); }

    // Regex fallback
    const regex = /<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i;
    const match = rawHtml.match(regex);
    if (match && match[1]) {
        console.log('Found __NEXT_DATA__ via regex, length:', match[1].length);
        return JSON.parse(match[1]);
    }

    throw new Error('__NEXT_DATA__ not found');
}

function extractBooksFromHTML(html, taskId) {
    const data = extractNextData(html);
    console.log('data keys:', Object.keys(data));
    const props = data.props;
    if (!props) throw new Error('props missing');
    console.log('props keys:', Object.keys(props));
    const initialState = props.initialState;
    if (!initialState) throw new Error('initialState missing');
    console.log('initialState keys:', Object.keys(initialState));
    const userProfile = initialState.userProfile;
    if (!userProfile) throw new Error('userProfile missing');
    const userId = Object.keys(userProfile)[0];
    const profile = userProfile[userId];
    const base = profile.baseInfo;
    const books = initialState.authorPageInfo?.[userId]?.bookListItems || [];

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
            // Extract HTML from result
            let html = null;
            if (task.result && typeof task.result === 'object') {
                html = task.result.content || task.result.html || null;
                console.log(`Task ${task.id}: result object, found content = ${!!html}`);
            } else if (typeof task.result === 'string') {
                try {
                    const parsed = JSON.parse(task.result);
                    html = parsed.content || parsed.html || null;
                    console.log(`Task ${task.id}: parsed string, found content = ${!!html}`);
                } catch(e) {
                    html = task.result;
                    console.log(`Task ${task.id}: treating as raw string`);
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
            console.error(err.stack);
            // Do NOT mark processed – will retry
        }
    }
}

setInterval(processCompletedTasks, 5000);
processCompletedTasks();

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Processor running on port ${PORT}`));
