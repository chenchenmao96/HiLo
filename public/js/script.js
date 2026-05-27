$(window).on("load", function() {
    $('.ui.tiny.post.modal').modal({
        observeChanges: true
    });

    // Add new post Modal functionality
    $("#newpost, a.item.newpost").click(function() {
        $('.ui.tiny.post.modal').modal('show');
    });

    // New post validator: participant must add both caption and photo.
    $('#postform').form({
        on: 'blur',
        fields: {
            body: {
                identifier: 'body',
                rules: [{
                    type: 'empty',
                    prompt: 'Please add a caption.'
                }]
            },
            picinput: {
                identifier: 'picinput',
                rules: [{
                    type: 'empty',
                    prompt: 'Please add a photo.'
                }]
            }
        },
        onSuccess: function(event, fields) {
            $('.actions .ui.button').addClass('disabled');
            $('.actions .ui.button').val('Posting...');
        }
    });
});
