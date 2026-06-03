const Script = require('../models/Script.js');
const User = require('../models/User');
const Notification = require('../models/Notification');
const helpers = require('./helpers');
const _ = require('lodash');
const dotenv = require('dotenv');
dotenv.config({ path: '.env' }); // See the file .env.example for the structure of .env

let script_feed = [];

function getConditionPrompt(condition) {
  const prompts = {
    1: "Please upload your photo of a positive event that happened in the past two weeks, and add a caption.",
    2: "Please upload your other photo of a positive event that happened in the past two weeks, and add a caption.",
    3: "Please upload your photo of a negative event that happened in the past two weeks, and add a caption.",
    4: "Please upload your other photo of a negative event that happened in the past two weeks, and add a caption."
  };
  return prompts[condition] || "Please upload a photo that happened in the past two weeks, and add a caption.";
}

function renderMakePostGate(res, user) {
  if (user.condition > 4) {
    return renderEndExperiment(res, user);
  }

  return res.render("condition_gate", {
    title: "Before Session",
    message: getConditionPrompt(user.condition),
    requiresPost: true,
    userCreatedAt: user.createdAt
  });
}

function renderEndExperiment(res, user) {
  return res.render("condition_gate", {
    title: "End of Experiment",
    message: "Thank you for participating. The experiment is now complete.",
    button: null,
    userCreatedAt: user.createdAt
  });
}

async function applyScheduledUserPostLikes(user) {
  for (const post of user.posts) {
    const condition = String(post.condition || "");
    if (!condition || !post.absTime) continue;

    const elapsed = Date.now() - new Date(post.absTime).getTime();
    const scheduledLikes = await Notification.find({
      condition: { "$in": ["", condition] },
      notificationType: "like",
      userReplyID: { $exists: false },
      time: { $lte: elapsed }
    }).exec();

    post.likes = scheduledLikes.length;
  }
}

async function ensureScheduledUserPostReplies(user) {
  let addedReply = false;

  for (const post of user.posts) {
    const condition = String(post.condition || "");
    if (!condition || !post.absTime) continue;

    const actorReplies = await Notification.find({
        condition: { "$in": ["", condition] },
        notificationType: "reply"
      })
      .populate("actor")
      .sort("time")
      .exec();

    for (const reply of actorReplies) {
      const replyAbsTime = new Date(new Date(post.absTime).getTime() + reply.time);
      const alreadyAdded = post.comments.some(comment => {
        const actorId = comment.actor && (comment.actor._id || comment.actor);
        return String(actorId) === String(reply.actor._id) &&
          comment.body === reply.replyBody &&
          new Date(comment.absTime).getTime() === replyAbsTime.getTime();
      });

      if (alreadyAdded) continue;

      user.numActorReplies = user.numActorReplies + 1;
      post.comments.push({
        actor: reply.actor._id,
        body: reply.replyBody,
        commentID: user.numActorReplies,
        relativeTime: post.relativeTime + reply.time,
        absTime: replyAbsTime,
        new_comment: false,
        liked: false,
        flagged: false,
        likes: 0
      });
      addedReply = true;
    }
  }

  return addedReply;
}

/**
 * GET /
 * Fetch and render newsfeed.
 */
exports.getScript = async (req, res, next) => {
  try {
    const one_day = 86400000;
    const account_created_ms = new Date(req.user.createdAt).getTime();
    const time_diff = Date.now() - account_created_ms;
    const time_limit = time_diff - one_day;

    let user = await User.findById(req.user.id)
      .populate("posts.comments.actor")
      .exec();
    const addedReplies = await ensureScheduledUserPostReplies(user);
    if (addedReplies) {
      user.markModified("posts");
      await user.save();
      user = await User.findById(req.user.id)
        .populate("posts.comments.actor")
        .exec();
    }
    await applyScheduledUserPostLikes(user);
    user.markModified("posts");

    // Normalize createdAt into a real Date
    let createdAtDate;
    if (user.createdAt instanceof Date) {
      createdAtDate = user.createdAt;
    } else if (user.createdAt.$date) {
      createdAtDate = new Date(user.createdAt.$date);
    } else {
      createdAtDate = new Date(user.createdAt);
    }
    const baseTime = createdAtDate.getTime();

    // If the user is no longer active, log them out
    if (!user.active) {
      return req.logout((err) => {
        if (err) return next(err);

        req.user = null;
        req.flash("errors", {
          msg: "Account is no longer active. Study is over.",
        });
        return res.redirect(
          "/login" + (req.query.r_id ? `?r_id=${req.query.r_id}` : "")
        );
      });
    }

    const current_day = Math.floor(time_diff / one_day);
    if (current_day < process.env.NUM_DAYS) {
      user.study_days[current_day] += 1;
      await user.save();
    }

    if (user.condition > 4) {
      return renderEndExperiment(res, user);
    }

    if (req.query.action === "continue" && user.condition <= 4) {
      console.log("continue");
      return renderMakePostGate(res, user);
    }

    // const currentCondition = computeCondition(user.createdAt, 15000, 4); // 15000 for testing, 180000 for real
    const currentCondition = user.condition;
    const currentConditionPosts = user.posts
      .filter(post => String(post.condition) === String(currentCondition))
      .sort((a, b) => b.absTime - a.absTime);

    if (user.condition <= 4 && currentConditionPosts.length === 0) {
      user.conditionStart = null;
      await user.save();
      return renderMakePostGate(res, user);
    }

    const condState = await getConditionState(user, 180000, 4); // 15000 for testing, 180000 for real
    console.log("Condition window →", condState);

    // END OF EXPERIMENT — after condition 4 finishes
    if (condState.state === "ended") {
      return renderEndExperiment(res, user);
    }

    // Pre condition page
    if (condState.state === "pre") {
      return renderMakePostGate(res, user);
    }

    // Post condition page
    if (condState.state === "post") {
      user.condition += 1;
      user.conditionStart = null;
      await user.save();
      return res.render("condition_gate", {
        title: "Session Finished",
        message: "Please wait for further instructions...",
        button: "Continue", 
        userCreatedAt: user.createdAt
      });
    }

    if (condState.state === "active") {
      script_feed = await Script.find({
        condition: String(currentCondition),
        $or: [
          { display_time: { $ne: null } },
          { time: { $lte: time_diff, $gte: 0 } }
        ],
      })
      .sort({ time: -1 })
      .populate({
        path: "actor",
        select: "username profile",
        populate: { path: "profile", select: "name picture" },
      })
      .populate({
        path: "comments.actor",
        select: "username profile",
        populate: { path: "profile", select: "name picture" },
      })
      .exec();

      // compute display_time only when active
      for (const post of script_feed) {
        const now = Date.now();

        if (!post.display_time) {
          const offset = Number(post.time) || 0;
          post.display_time = baseTime + offset;
        } else {
          const max = Number(post.display_time) * 24 * 60 * 60 * 1000;
          // const offset = Math.random() * max;
          post.display_time = now - max;
        }

        if (Array.isArray(post.comments)) {
          post.comments.forEach((c) => {
            if (!c.display_time) {
              const offset = Number(c.time) || 0;
              c.display_time = baseTime + offset;
            }
            // else{
            //   const max = Number(post.display_time) * 24 * 60*60*1000;
            //   const offset = Math.random() * max;
            //   c.display_time = now - offset;
            // }
          });
        }
      }
      script_feed.sort((a, b) => b.display_time - a.display_time)
    }


    await user.save();

    // Use plain objects for display so filtering future comments does not delete
    // scheduled actor comments from the user's saved post document.
    let user_posts = currentConditionPosts.slice(0, 1).map(post => post.toObject ? post.toObject() : post);

    const finalfeed = helpers.getFeed(
      user_posts,
      script_feed,
      user,
      process.env.FEED_ORDER,
      process.env.REMOVE_FLAGGED_CONTENT == "TRUE",
      true
    );

    console.log("Script Size is now: " + finalfeed.length);
    console.log(`Rendering Condition ${currentCondition} — ${script_feed.length} posts found`);

    // ✅ Nothing for Pug to calculate anymore
    res.render("script", {
      script: finalfeed,
      showNewPostIcon: false,
      conditionStartTime: user.conditionStart,
    });
  } catch (err) {
    next(err);
  }
};

// Computes which condition the user should currently see
function computeCondition(startTime, windowMs = 180000, totalConditions = 4) {
  const elapsed = Date.now() - new Date(startTime).getTime();
  const index = Math.floor(elapsed / windowMs) % totalConditions;
  return index + 1;
}

function getConditionState(user, windowMs = 180000, totalConditions = 4) {
  if (user.condition > totalConditions) {
      return { state: "ended", condition: totalConditions };
  }

  if ( !user.conditionStart ) return { state: "pre", condition: user.condition};

  const elapsed = Date.now() - new Date(user.conditionStart).getTime();

  // const cycleLength = windowMs;
  // const fullExperimentDuration = totalConditions * windowMs;

  // // AFTER ALL CONDITIONS
  // if (elapsed >= fullExperimentDuration) {
  //     return { state: "ended", condition: totalConditions };
  // }

  if (elapsed < 0) return { state: "pre", condition: user.condition };
  if (elapsed >= windowMs) {
    return { state: "post", condition: user.condition };
  }
  return { state: "active", condition: user.condition };
}



/*
 * Post /post/new
 * Record a new user-made post. Include any actor replies (comments) that go along with it.
 */
exports.newPost = async(req, res, next) => {
    try {
        const user = await User.findById(req.user.id).exec();
        const body = (req.body.body || "").trim();

        if (user.condition > 4) {
            return res.redirect('/');
        }

        if (req.file && body) {
            user.numPosts = user.numPosts + 1; // Count begins at 0
            const currDate = Date.now();
            const currentCondition = String(user.condition);

            let post = {
                type: "user_post",
                postID: user.numPosts,
                body,
                condition: user.condition,
                picture: req.file.filename,
                liked: false,
                likes: 0,
                comments: [],
                absTime: currDate,
                relativeTime: currDate - user.createdAt,
            };

            // Find any Actor replies (comments) that go along with this post
            const actor_replies = await Notification.find({
                    condition: { "$in": ["", currentCondition] }
                })
                .where('notificationType').equals('reply')
                .populate('actor')
                .sort('time')
                .exec();

            // If there are Actor replies (comments) that go along with this post, add them to the user's post.
            if (actor_replies.length > 0) {
                for (const reply of actor_replies) {
                    user.numActorReplies = user.numActorReplies + 1; // Count begins at 0
                    const tmp_actor_reply = {
                        actor: reply.actor._id,
                        body: reply.replyBody,
                        commentID: user.numActorReplies,
                        relativeTime: post.relativeTime + reply.time,
                        absTime: new Date(user.createdAt.getTime() + post.relativeTime + reply.time),
                        new_comment: false,
                        liked: false,
                        flagged: false,
                        likes: 0
                    };
                    post.comments.push(tmp_actor_reply);
                }
            }

            user.posts.unshift(post); // Add most recent user-made post to the beginning of the array
            user.conditionStart = Date.now();
            await user.save();
            res.redirect('/');
        } else {
            req.flash('errors', { msg: 'ERROR: Your post did not get sent. Please include a photo and a caption.' });
            res.redirect('/');
        }
    } catch (err) {
        next(err);
    }
};

/**
 * POST /feed/
 * Record user's actions on ACTOR posts. 
 */
exports.postUpdateFeedAction = async(req, res, next) => {
    try {
        const user = await User.findById(req.user.id).exec();
        // Check if user has interacted with the post before.
        let feedIndex = _.findIndex(user.feedAction, function(o) { return o.post == req.body.postID; });

        // If the user has not interacted with the post before, add the post to user.feedAction.
        if (feedIndex == -1) {
            const cat = {
                post: req.body.postID,
                postCondition: req.body.postCondition,
            };
            feedIndex = user.feedAction.push(cat) - 1;
        }

        // User created a new comment on the post.
        if (req.body.new_comment) {
            user.numComments = user.numComments + 1;
            const cat = {
                new_comment: true,
                new_comment_id: user.numComments,
                body: req.body.comment_text,
                relativeTime: req.body.new_comment - user.createdAt,
                absTime: req.body.new_comment,
                liked: false,
                flagged: false,
            }
            user.feedAction[feedIndex].comments.push(cat);
        }
        // User interacted with a comment on the post.
        else if (req.body.commentID) {
            const isUserComment = (req.body.isUserComment == 'true');
            // Check if user has interacted with the comment before.
            let commentIndex = (isUserComment) ?
                _.findIndex(user.feedAction[feedIndex].comments, function(o) {
                    return o.new_comment_id == req.body.commentID && o.new_comment == isUserComment
                }) :
                _.findIndex(user.feedAction[feedIndex].comments, function(o) {
                    return o.comment == req.body.commentID && o.new_comment == isUserComment
                });

            // If the user has not interacted with the comment before, add the comment to user.feedAction[feedIndex].comments
            if (commentIndex == -1) {
                const cat = {
                    comment: req.body.commentID
                };
                user.feedAction[feedIndex].comments.push(cat);
                commentIndex = user.feedAction[feedIndex].comments.length - 1;
            }

            // User liked the comment.
            if (req.body.like) {
                const like = req.body.like;
                user.feedAction[feedIndex].comments[commentIndex].likeTime.push(like);
                user.feedAction[feedIndex].comments[commentIndex].liked = true;
                if (req.body.isUserComment != 'true') user.numCommentLikes++;
            }

            // User unliked the comment.
            if (req.body.unlike) {
                const unlike = req.body.unlike;
                user.feedAction[feedIndex].comments[commentIndex].unlikeTime.push(unlike);
                user.feedAction[feedIndex].comments[commentIndex].liked = false;
                if (req.body.isUserComment != 'true') user.numCommentLikes--;
            }

            // User flagged the comment.
            else if (req.body.flag) {
                const flag = req.body.flag;
                user.feedAction[feedIndex].comments[commentIndex].flagTime.push(flag);
                user.feedAction[feedIndex].comments[commentIndex].flagged = true;
            }

            // User unflagged the comment.
            else if (req.body.unflag) {
                const unflag = req.body.unflag;
                user.feedAction[feedIndex].comments[commentIndex].unflagTime.push(unflag);
                user.feedAction[feedIndex].comments[commentIndex].flagged = false;
            }
        }
        // User interacted with the post.
        else {
            // User flagged the post.
            if (req.body.flag) {
                const flag = req.body.flag;
                user.feedAction[feedIndex].flagTime.push(flag);
                user.feedAction[feedIndex].flagged = true;
            }

            // User unflagged the post.
            else if (req.body.unflag) {
                const unflag = req.body.unflag;
                user.feedAction[feedIndex].unflagTime.push(unflag);
                user.feedAction[feedIndex].flagged = false;
            }

            // User liked the post.
            else if (req.body.like) {
                const like = req.body.like;
                user.feedAction[feedIndex].likeTime.push(like);
                user.feedAction[feedIndex].liked = true;
                user.numPostLikes++;
            }
            // User unliked the post.
            else if (req.body.unlike) {
                const unlike = req.body.unlike;
                user.feedAction[feedIndex].unlikeTime.push(unlike);
                user.feedAction[feedIndex].liked = false;
                user.numPostLikes--;
            }
            // User read the post.
            else if (req.body.viewed) {
                const view = req.body.viewed;
                user.feedAction[feedIndex].readTime.push(view);
                user.feedAction[feedIndex].rereadTimes++;
                user.feedAction[feedIndex].mostRecentTime = Date.now();
            } else {
                console.log('Something in feedAction went crazy. You should never see this.');
            }
        }
        await user.save();
        res.send({ result: "success", numComments: user.numComments });
    } catch (err) {
        next(err);
    }
};

/**
 * POST /userPost_feed/
 * Record user's actions on USER posts. 
 */
exports.postUpdateUserPostFeedAction = async(req, res, next) => {
    try {
        const user = await User.findById(req.user.id).exec();
        // Find the index of object in user.posts
        let feedIndex = _.findIndex(user.posts, function(o) { return o.postID == req.body.postID; });

        if (feedIndex == -1) {
            // Should not happen.
        }
        // User created a new comment on the post.
        else if (req.body.new_comment) {
            user.numComments = user.numComments + 1;
            const cat = {
                body: req.body.comment_text,
                commentID: user.numComments,
                relativeTime: req.body.new_comment - user.createdAt,
                absTime: req.body.new_comment,
                new_comment: true,
                liked: false,
                flagged: false,
                likes: 0
            };
            user.posts[feedIndex].comments.push(cat);
        }
        // User interacted with a comment on the post.
        else if (req.body.commentID) {
            const commentIndex = _.findIndex(user.posts[feedIndex].comments, function(o) {
                return o.commentID == req.body.commentID && o.new_comment == (req.body.isUserComment == 'true');
            });
            if (commentIndex == -1) {
                console.log("Should not happen.");
            }
            // User liked the comment.
            else if (req.body.like) {
                user.posts[feedIndex].comments[commentIndex].liked = true;
            }
            // User unliked the comment. 
            else if (req.body.unlike) {
                user.posts[feedIndex].comments[commentIndex].liked = false;
            }
            // User flagged the comment.
            else if (req.body.flag) {
                user.posts[feedIndex].comments[commentIndex].flagged = true;
            }
        }
        // User interacted with the post. 
        else {
            // User liked the post.
            if (req.body.like) {
                user.posts[feedIndex].liked = true;
            }
            // User unliked the post.
            if (req.body.unlike) {
                user.posts[feedIndex].liked = false;
            }
        }
        await user.save();
        res.send({ result: "success", numComments: user.numComments });
    } catch (err) {
        next(err);
    }
}
