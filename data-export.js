const dotenv = require('dotenv');
dotenv.config({ path: '.env' });

const User = require('./models/User.js');
require('./models/Actor.js');
require('./models/Script.js');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

const color_start = '\x1b[33m%s\x1b[0m';
const color_success = '\x1b[32m%s\x1b[0m';

const SESSION_LABELS = {
    1: 'positive_1',
    2: 'positive_2',
    3: 'negative_1',
    4: 'negative_2'
};

mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection;
db.on('error', (err) => {
    console.error(err);
    console.log('%s MongoDB connection error. Please make sure MongoDB is running.');
    process.exit();
});
console.log(color_success, 'Successfully connected to db.');

async function getUsers() {
    return User
        .find({ isAdmin: false })
        .populate('posts.comments.actor')
        .populate({
            path: 'feedAction.post',
            populate: [
                { path: 'actor' },
                { path: 'comments.actor' }
            ]
        })
        .exec();
}

function iso(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function sum(numbers) {
    return (numbers || []).reduce((total, value) => total + (Number(value) || 0), 0);
}

function joinList(values) {
    return (values || [])
        .filter(value => value !== undefined && value !== null && value !== '')
        .map(value => String(value))
        .join('; ');
}

function actorName(actor) {
    if (!actor) return '';
    return actor.username || actor.profile?.name || String(actor);
}

function postLabel(post) {
    if (!post) return '';
    return post.postID || post.id || post._id || '';
}

function commentLabel(comment) {
    if (!comment) return '';
    return comment.commentID || comment._id || comment.comment || '';
}

function getSessionUserPost(user, session) {
    return (user.posts || [])
        .filter(post => Number(post.condition) === Number(session))
        .sort((a, b) => new Date(a.absTime || 0) - new Date(b.absTime || 0))[0];
}

function getSessionFeedActions(user, session) {
    return (user.feedAction || [])
        .filter(action => action.post && String(action.post.condition) === String(session));
}

function getActorCommentsOnUserPost(userPost) {
    return (userPost?.comments || []).filter(comment => !comment.new_comment);
}

function getUserCommentsOnActorPosts(feedActions) {
    const rows = [];
    for (const action of feedActions) {
        for (const comment of action.comments || []) {
            if (!comment.new_comment) continue;
            rows.push([
                `post=${postLabel(action.post)}`,
                `commentID=${comment.new_comment_id}`,
                `time=${iso(comment.absTime)}`,
                `body=${comment.body || ''}`
            ].join('|'));
        }
    }
    return rows;
}

function getLikedActorComments(feedActions) {
    const rows = [];
    for (const action of feedActions) {
        for (const comment of action.comments || []) {
            if (comment.new_comment || !comment.liked) continue;
            rows.push([
                `post=${postLabel(action.post)}`,
                `comment=${commentLabel(comment)}`,
                `likeTimes=${joinList((comment.likeTime || []).map(iso))}`
            ].join('|'));
        }
    }
    return rows;
}

function buildRecord(user, session) {
    const userPost = getSessionUserPost(user, session);
    const actorComments = getActorCommentsOnUserPost(userPost);
    const feedActions = getSessionFeedActions(user, session);
    const likedActorPosts = feedActions.filter(action => action.liked);
    const commentedActorPosts = getUserCommentsOnActorPosts(feedActions);
    const likedActorComments = getLikedActorComments(feedActions);
    const readTimeMs = sum(feedActions.flatMap(action => action.readTime || []));

    return {
        ParticipantID: user.mturkID || '',
        StudyDate: user.studyDate || '',
        Username: user.username || '',
        UserMongoID: String(user._id || ''),
        AccountCreatedAt: iso(user.createdAt),
        CurrentCondition: user.condition || '',
        Session: session,
        SessionLabel: SESSION_LABELS[session] || '',
        SessionStartedAt: iso(userPost?.absTime),
        ParticipantPostID: userPost?.postID ?? '',
        ParticipantPostCreatedAt: iso(userPost?.absTime),
        ParticipantPostCaption: userPost?.body || '',
        ParticipantPostPicture: userPost?.picture || '',
        ParticipantPostLikeCount: userPost?.likes ?? 0,
        ActorCommentsOnParticipantPostCount: actorComments.length,
        ActorCommentsOnParticipantPost: joinList(actorComments.map(comment => [
            `actor=${actorName(comment.actor)}`,
            `time=${iso(comment.absTime)}`,
            `body=${comment.body || ''}`
        ].join('|'))),
        BotPostsReadCount: feedActions.filter(action => (action.readTime || []).length > 0).length,
        BotPostsReadTimeMs: readTimeMs,
        BotPostsLikedCount: likedActorPosts.length,
        BotPostsLiked: joinList(likedActorPosts.map(action => [
            `post=${postLabel(action.post)}`,
            `actor=${actorName(action.post?.actor)}`,
            `likeTimes=${joinList((action.likeTime || []).map(iso))}`,
            `unlikeTimes=${joinList((action.unlikeTime || []).map(iso))}`
        ].join('|'))),
        CommentsOnBotPostsCount: commentedActorPosts.length,
        CommentsOnBotPosts: joinList(commentedActorPosts),
        BotCommentsLikedCount: likedActorComments.length,
        BotCommentsLiked: joinList(likedActorComments),
        FeedActionPostIDsSeen: joinList(feedActions.map(action => postLabel(action.post))),
        PageLog: joinList((user.pageLog || []).map(pageLog => `${iso(pageLog.time)}|${pageLog.page}`)),
        TotalPageTimeMs: sum(user.pageTimes || []),
        LoginLog: joinList((user.log || []).map(log => `${iso(log.time)}|${log.ipAddress || ''}`))
    };
}

async function getDataExport() {
    const users = await getUsers();
    console.log(color_start, 'Starting the HiLo data export script...');

    const outputDir = path.join(__dirname, 'outputFiles');
    fs.mkdirSync(outputDir, { recursive: true });

    const currentDate = new Date();
    const outputFilename =
        'hilo-session-dataExport' +
        `.${currentDate.getMonth() + 1}-${currentDate.getDate()}-${currentDate.getFullYear()}` +
        `.${currentDate.getHours()}-${currentDate.getMinutes()}-${currentDate.getSeconds()}`;
    const outputFilepath = path.join(outputDir, `${outputFilename}.csv`);

    const header = [
        'ParticipantID',
        'StudyDate',
        'Username',
        'UserMongoID',
        'AccountCreatedAt',
        'CurrentCondition',
        'Session',
        'SessionLabel',
        'SessionStartedAt',
        'ParticipantPostID',
        'ParticipantPostCreatedAt',
        'ParticipantPostCaption',
        'ParticipantPostPicture',
        'ParticipantPostLikeCount',
        'ActorCommentsOnParticipantPostCount',
        'ActorCommentsOnParticipantPost',
        'BotPostsReadCount',
        'BotPostsReadTimeMs',
        'BotPostsLikedCount',
        'BotPostsLiked',
        'CommentsOnBotPostsCount',
        'CommentsOnBotPosts',
        'BotCommentsLikedCount',
        'BotCommentsLiked',
        'FeedActionPostIDsSeen',
        'PageLog',
        'TotalPageTimeMs',
        'LoginLog'
    ].map(column => ({ id: column, title: column }));

    const csvWriter = createCsvWriter({
        path: outputFilepath,
        header
    });

    const records = [];
    for (const user of users) {
        for (const session of [1, 2, 3, 4]) {
            records.push(buildRecord(user, session));
        }
    }

    await csvWriter.writeRecords(records);
    console.log(color_success, `Data export completed. File exported to: ${outputFilepath} with ${records.length} session rows.`);
    db.close();
    console.log(color_start, 'Closed db connection.');
}

getDataExport().catch((err) => {
    console.error(err);
    db.close();
    process.exit(1);
});
