const { createClient } = require('@supabase/supabase-js');
const cheerio = require('cheerio');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
            const books = extractBooksFromHTML(task.result, task.id);
            if (books.length) await upsertBooks(books);
            await supabase.from('task_queue').update({ processed: true }).eq('id', task.id);
        } catch (err) {
            console.error(`Task ${task.id} failed:`, err.message);
        }
    }
}

setInterval(processCompletedTasks, 5000);
processCompletedTasks();
