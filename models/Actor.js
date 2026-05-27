const mongoose = require('mongoose');

const actorSchema = new mongoose.Schema({
    username: { type: String, unique: true },
    profile: {
        name: String,
        gender: String,
        age: Number,
        bio: String,
        picture: String
    },
    class: String,
    condition: String // For experimental use (can be used to define the type of actor)
}, { timestamps: true });

const Actor = mongoose.model('Actor', actorSchema);
module.exports = Actor;