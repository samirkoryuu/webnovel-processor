const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cheerio = require('cheerio');

const app = express();
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Health check endpoint for UptimeRobot
app.get('/health', (req, res) => res.status(200).send('OK'));

// Extract books from the HTML stored in task_queue.result
function extractBooksFromHTML(html, taskId) {
    const $ = cheerio.load(html);
    const nextDataScript = $('#__NEXT_DATA__').html();
    if (!nextDataScript) throw new Error('__NEXT_DATA__ not found');

    const data = JSON.parse(nextDataScript);
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
        views: 0,                 // not present in HTML, set default
        power_ranking: null,      // not present in HTML
        task_id: taskId,
        created_at: new Date().toISOString(),
    }));
}

// Insert or update each book – one row per (penname, book)
async function upsertBooks(books) {
    for (const book of books) {
        const { error } = await supabase
            .from('recent_findings')
            .upsert(book, { onConflict: 'penname, book' });
        if (error) console.error('Upsert error:', error.message);
    }
}

// Process all unprocessed completed tasks
async function processCompletedTasks() {
    const { data: tasks, error } = await supabase
        .from('task_queue')
        .select('id, result')
        .eq('status', 'completed')
        .eq('processed', false)
        .order('id', { ascending: true })
        .limit(10);

    if (error) {
        console.error('Error fetching tasks:', error.message);
        return;
    }
    if (!tasks || tasks.length === 0) return;

    for (const task of tasks) {
        try {
            const books = extractBooksFromHTML(task.result, task.id);
            if (books.length) {
                await upsertBooks(books);
                console.log(`Task ${task.id}: processed ${books.length} books`);
            } else {
                console.log(`Task ${task.id}: no books found`);
            }
            // Mark task as processed
            await supabase
                .from('task_queue')
                .update({ processed: true })
                .eq('id', task.id);
        } catch (err) {
            console.error(`Task ${task.id} failed:`, err.message);
            // Do NOT mark as processed – will retry next cycle
        }
    }
}

// Run the processor every 5 seconds
setInterval(processCompletedTasks, 5000);
processCompletedTasks(); // also run immediately on start

// Start the HTTP server (required for Render web service)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`WebNovel processor running on port ${PORT}, checking tasks every 5s`);
});
