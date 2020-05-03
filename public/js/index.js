var request = window.superagent;

var activeChannel;
var client;
var typingMembers = new Set();

var activeChannelPage;

var userContext = { identity: null};

$(document).ready(function() {
	$('#login-name').focus();

	$('#login-button').on('click', function() {
		var identity = $('#login-name').val();
		if (!identity) { return; }

		userContext.identity = identity;

		logIn(identity, identity);
	});

	$('#login-name').on('keydown', function(e) {
		if (e.keyCode === 13) { $('#login-button').click(); }
	});

	$('#message-body-input').on('keydown', function(e) {
		if (e.keyCode === 13) { $('#send-message').click(); }
		else if (activeChannel) { activeChannel.typing(); }
	});

	$('#edit-channel').on('click', function() {
		$('#update-channel-display-name').val(activeChannel.friendlyName || '');
		$('#update-channel-unique-name').val(activeChannel.uniqueName || '');
		$('#update-channel-desc').val(activeChannel.attributes.description || '');
		$('#update-channel-private').prop('checked', activeChannel.isPrivate);
		$('#update-channel').show();
		$('#overlay').show();
	});

	var isUpdatingConsumption = false;
	$('#channel-messages').on('scroll', function(e) {
		var $messages = $('#channel-messages');

		if ($('#channel-messages dl').height() - 50 < $messages.scrollTop() + $messages.height()) {
			activeChannel.getMessages(1).then(messages => {
				var newestMessageIndex = messages.length ? messages[0].index : 0;
				if (!isUpdatingConsumption && activeChannel.lastConsumedMessageIndex !== newestMessageIndex) {
					isUpdatingConsumption = true;
					activeChannel.updateLastConsumedMessageIndex(newestMessageIndex).then(function() {
						isUpdatingConsumption = false;
					});
				}
			});
		}

		var self = $(this);
		if ($messages.scrollTop() < 50 && activeChannelPage
			&& activeChannelPage.hasPrevPage && !self.hasClass('loader'))
		{
			self.addClass('loader');
			var initialHeight = $('ul', self).height();
			activeChannelPage.prevPage().then(page => {
				page.items.reverse().forEach(prependMessage);
				activeChannelPage = page;
			//	var difference = $('ul', self).height() - initialHeight;
			//	self.scrollTop(difference);
				self.removeClass('loader');
			});
		}
	});

	$('#update-channel .remove-button').on('click', function() {
		$('#update-channel').hide();
		$('#overlay').hide();
	});

	$('#delete-channel').on('click', function() {
		activeChannel && activeChannel.delete();
	});

	$('#join-channel').on('click', function() {
		activeChannel.join().then(setActiveChannel);
	});

	$('#create-channel .remove-button').on('click', function() {
		$('#create-channel').hide();
		$('#overlay').hide();
	});

	$('#create-channel-button').on('click', function() {
		$('#create-channel').show();
		$('#overlay').show();
	});

	$('#create-new-channel').on('click', function() {
		var attributes = {
			description: $('#create-channel-desc').val()
		};

		var isPrivate = $('#create-channel-private').is(':checked');
		var friendlyName = $('#create-channel-display-name').val();
		var uniqueName = $('#create-channel-unique-name').val();

		client.createChannel({
			attributes: attributes,
			friendlyName: friendlyName,
			isPrivate: isPrivate,
			uniqueName: uniqueName
		}).then(function joinChannel(channel) {
			$('#create-channel').hide();
			$('#overlay').hide();
			return channel.join();
		}).then(setActiveChannel);
	});

	$('#update-channel-submit').on('click', function() {
		var desc = $('#update-channel-desc').val();
		var friendlyName = $('#update-channel-display-name').val();
		var uniqueName = $('#update-channel-unique-name').val();

		var promises = [];
		if (desc !== activeChannel.attributes.description) {
			promises.push(activeChannel.updateAttributes({ description: desc }));
		}

		if (friendlyName !== activeChannel.friendlyName) {
			promises.push(activeChannel.updateFriendlyName(friendlyName));
		}

		if (uniqueName !== activeChannel.uniqueName) {
			promises.push(activeChannel.updateUniqueName(uniqueName));
		}

		Promise.all(promises).then(function() {
			$('#update-channel').hide();
			$('#overlay').hide();
		});
	});
});

function googleLogIn(googleUser) {
	var profile = googleUser.getBasicProfile();
	var identity = profile.getEmail().toLowerCase();
	var fullName = profile.getName();
	logIn(identity, fullName);
}

function logIn(identity, displayName) {
	request('/getToken?identity=' + identity, function(err, res) {
		if (err) { throw new Error(res.text); }

		var token = res.text;

		userContext.identity = identity;

		Twilio.Chat.Client.create(token, { logLevel: 'info' })
			.then(function(createdClient) {
				$('#login').hide();
				$('#overlay').hide();
				client = createdClient;
				client.on('tokenAboutToExpire', () => {
					request('/getToken?identity=' + identity, function(err, res) {
						if (err) {
							console.error('Failed to get a token ', res.text);
							throw new Error(res.text);
						}
						console.log('Got new token!', res.text);
						client.updateToken(res.text);
					});
				});

				$('#profile label').text(client.user.friendlyName || client.user.identity);
				$('#profile img').attr('src', 'http://gravatar.com/avatar/' + MD5(identity) + '?s=40&d=mm&r=g');

				client.user.on('updated', function() {
					$('#profile label').text(client.user.friendlyName || client.user.identity);
				});

				var connectionInfo = $('#profile #presence');
				connectionInfo
					.removeClass('online offline connecting denied')
					.addClass(client.connectionState);
				client.on('connectionStateChanged', function(state) {
					connectionInfo
						.removeClass('online offline connecting denied')
						.addClass(client.connectionState);
				});

				client.getSubscribedChannels().then(updateChannels);

				client.on('channelJoined', function(channel) {
					channel.on('messageAdded', updateUnreadMessages);
					channel.on('messageAdded', updateChannels);
					updateChannels();
				});

				client.on('channelInvited', updateChannels);
				client.on('channelAdded', updateChannels);
				client.on('channelUpdated', updateChannels);
				client.on('channelLeft', leaveChannel);
				client.on('channelRemoved', leaveChannel);
			})
			.catch(function(err) {
				throw err;
			})
	});
}

function updateUnreadMessages(message) {
	var channel = message.channel;
	if (channel !== activeChannel) {
		$('#sidebar li[data-sid="' + channel.sid + '"] span').addClass('new-messages');
	}
}


//*************************************************
//	channels
//*************************************************
function leaveChannel(channel) {
	if (channel == activeChannel && channel.status !== 'joined') {
		clearActiveChannel();
	}

	channel.removeListener('messageAdded', updateUnreadMessages);

	updateChannels();
}

function addKnownChannel(channel) {
	var $el = $('<li/>')
		.attr('data-sid', channel.sid)
		.on('click', function() {
			setActiveChannel(channel);
		});

	var $title = $('<span/>')
		.text(channel.friendlyName)
		.appendTo($el);

	$('#known-channels ul').append($el);
}

function addPublicChannel(channel) {
	var $el = $('<li/>')
		.attr('data-sid', channel.sid)
		.attr('id', channel.sid)
		.on('click', function() {
			channel.getChannel().then(channel => {
				channel.join().then(channel => {
					setActiveChannel(channel);
					removePublicChannel(channel);
				});
			});
		});

	var $title = $('<span/>')
		.text(channel.friendlyName)
		.appendTo($el);

	$('#public-channels ul').append($el);
}

function addInvitedChannel(channel) {
	var $el = $('<li/>')
		.attr('data-sid', channel.sid)
		.on('click', function() {
			setActiveChannel(channel);
		});

	var $title = $('<span class="invited"/>')
		.text(channel.friendlyName)
		.appendTo($el);

	var $decline = $('<div class="remove-button glyphicon glyphicon-remove"/>')
		.on('click', function(e) {
			e.stopPropagation();
			channel.decline();
		}).appendTo($el);

	$('#invited-channels ul').append($el);
}

function addJoinedChannel(channel) {
	var $el = $('<li/>')
		.attr('data-sid', channel.sid)
		.on('click', function() {
			setActiveChannel(channel);
		});

	var $title = $('<span class="joined"/>')
		.text(channel.friendlyName)
		.appendTo($el);

	var $count = $('<span class="messages-count"/>')
		.appendTo($el);

	/*
	channel.getUnreadMessagesCount().then(count => {
		if (count > 0) {
			$el.addClass('new-messages');
			$count.text(count);
		}
	});
	*/

	var $leave = $('<div class="remove-button glyphicon glyphicon-remove"/>')
		.on('click', function(e) {
			e.stopPropagation();
			channel.leave();
		}).appendTo($el);

	$('#my-channels ul').append($el);
}

function removeLeftChannel(channel) {
	$('#my-channels li[data-sid=' + channel.sid + ']').remove();

	if (channel === activeChannel) {
		clearActiveChannel();
	}
}

function removePublicChannel(channel) {
	$('#public-channels li[data-sid=' + channel.sid + ']').remove();
}


function setActiveChannel(channel) {
	if (activeChannel) {
		activeChannel.removeListener('messageAdded', addMessage);
		activeChannel.removeListener('updated', updateActiveChannel);
		activeChannel.removeListener('memberUpdated', updateMember);
	}

	activeChannel = channel;

	$('#channel-title').text(channel.friendlyName);
	$('#channel-messages dl').empty();
	$('#channel-members ul').empty();
	activeChannel.getAttributes().then(function(attributes) {
		$('#channel-desc').text(attributes.description);
	});

	$('#send-message').off('click');
	$('#send-message').on('click', function() {
		var body = $('#message-body-input').val();
		channel.sendMessage(body).then(function() {
			$('#message-body-input').val('').focus();
			$('#channel-messages').scrollTop($('#channel-messages dl').height());
			$('#channel-messages li.last-read').removeClass('last-read');
		});
	});

	activeChannel.on('updated', updateActiveChannel);

	$('#no-channel').hide();
	$('#channel').show();

	if (channel.status !== 'joined') {
		$('#channel').addClass('view-only');
		return;
	} else {
		$('#channel').removeClass('view-only');
	}

	channel.getMessages(30).then(function(page) {
		activeChannelPage = page;
		page.items.forEach(addMessage);

		channel.on('messageAdded', addMessage);

		var newestMessageIndex = page.items.length ? page.items[page.items.length - 1].index : 0;
		var lastIndex = channel.lastConsumedMessageIndex;
		if (lastIndex && lastIndex !== newestMessageIndex) {
			var $li = $('li[data-index='+ lastIndex + ']');
			var top = $li.position() && $li.position().top;
			$li.addClass('last-read');
			$('#channel-messages').scrollTop(top + $('#channel-messages').scrollTop());
		}

		if ($('#channel-messages dl').height() <= $('#channel-messages').height()) {
			channel.updateLastConsumedMessageIndex(newestMessageIndex).then(updateChannels);
		}

		return channel.getMembers();
	}).then(function(members) {
		updateMembers();

		channel.on('memberJoined', updateMembers);
		channel.on('memberLeft', updateMembers);
		channel.on('memberUpdated', updateMember);

		members.forEach(member => {
			member.getUser().then(user => {
				user.on('updated', () => {
					updateMember.bind(null, member, user);
					updateMembers();
				});
			});
		});
	});

	$('#message-body-input').focus();
}

function clearActiveChannel() {
	$('#channel').hide();
	$('#no-channel').show();
}

function updateActiveChannel() {
	$('#channel-title').text(activeChannel.friendlyName);
	$('#channel-desc').text(activeChannel.attributes.description);
}


//*************************************************
//	messages
//*************************************************
function formatTimestamp(time) {
	var minutes = time.getMinutes();
	var ampm = Math.floor(time.getHours()/12) ? 'PM' : 'AM';
	if (minutes < 10) { minutes = '0' + minutes; }

	return (time.getHours()%12) + ':' + minutes + ' ' + ampm;
}

function createMessage(message) {
	var $el = $('<div class="'
		+ ($('#login-name').val() == message.author ? 'out' : 'in')
		+ '"/>').attr('data-index', message.index);

	var $author = $('<dt/>')
		.text(message.author)
		.appendTo($el);

	var $timestamp = $('<span class="timestamp"/>')
		.text(formatTimestamp(message.timestamp))
		.appendTo($author);

	var $body = $('<dd/>')
		.text(message.body)
		.appendTo($el);

	return $el;
}

function prependMessage(message) {
	var $messages = $('#channel-messages');
	var $el = createMessage(message);
	$('#channel-messages dl').prepend($el);
}

function addMessage(message) {
	var $messages = $('#channel-messages');
	var $el = createMessage(message);
	$('#channel-messages dl').append($el);
}


//*************************************************
//	members
//*************************************************
function updateChannels()
{
	client.getSubscribedChannels().then(page =>
	{
		subscribedChannels = page.items.sort(function(a, b) {
			return a.friendlyName > b.friendlyName;
		});
		$('#known-channels ul').empty();
		$('#invited-channels ul').empty();
		$('#my-channels ul').empty()
		subscribedChannels.forEach(function(channel) {
			switch (channel.status) {
				case 'joined':
					addJoinedChannel(channel);
					break;
				case 'invited':
					addInvitedChannel(channel);
					break;
				default:
					addKnownChannel(channel);
					break;
			}
		});
		client.getPublicChannelDescriptors().then(page => {
			publicChannels = page.items.sort(function(a, b) {
				return a.friendlyName > b.friendlyName;
			});
			$('#public-channels ul').empty();
			publicChannels.forEach(function(channel) {
				var result = subscribedChannels.find(item => item.sid === channel.sid);
				console.log('Adding public channel ' + channel.sid + ' ' + channel.status + ', result=' + result);
				if (result === undefined) {
					addPublicChannel(channel);
				}
			});
		});
	});
}


//*************************************************
//	members
//*************************************************
function addMember(member) {
	member.getUser().then(user => {
		var $el = $('<li/>')
			.attr('data-identity', member.identity);

		var $img = $('<img/>')
			.attr('src', 'http://gravatar.com/avatar/' + MD5(member.identity.toLowerCase()) + '?s=20&d=mm&r=g')
			.appendTo($el);


		let hasReachability = (user.online !== null) && (typeof user.online !== 'undefined');
		var $span = $('<span/>')
			.text(user.friendlyName || user.identity)
			.addClass(hasReachability ? ( user.online ? 'member-online' : 'member-offline' ) : '')
			.appendTo($el);

		var $remove = $('<div class="remove-button glyphicon glyphicon-remove"/>')
			.on('click', member.remove.bind(member))
			.appendTo($el);

		updateMember(member, user);

		$('#channel-members ul').append($el);
	});
}

function updateMembers() {
	$('#channel-members ul').empty();

	activeChannel.getMembers()
		.then(members => members
				.sort(function(a, b) { return a.identity > b.identity; })
				.sort(function(a, b) { return a.getUser().then(user => user.online) < b.getUser().then(user => user.online); })
				.forEach(addMember));

}

function updateMember(member, user) {
	if (user === undefined) { return; }
	if (member.identity === decodeURIComponent(client.identity)) { return; }

	var $lastRead = $('#channel-messages p.members-read img[data-identity="' + member.identity + '"]');

	if (!$lastRead.length) {
		$lastRead = $('<img/>')
			.attr('src', 'http://gravatar.com/avatar/' + MD5(member.identity) + '?s=20&d=mm&r=g')
			.attr('title', user.friendlyName || member.identity)
			.attr('data-identity', member.identity);
	}

	var lastIndex = member.lastConsumedMessageIndex;
	if (lastIndex) {
		$('#channel-messages li[data-index=' + lastIndex + '] p.members-read').append($lastRead);
	}
}
