document.addEventListener('alpine:init', () => {
	Alpine.data('chat', ({ gameName = '' }) => ({
		chatHistory: [],
		message: '',

		handleSubmit(e) {
			if (e.shiftKey && e.key === 'Enter') return;
			if (!this.message) return;

			this.sendEvent(this.message);
			this.$nextTick(() => {
				this.message = '';
				this.$refs.chatMessage.focus();
			});
		},

		init() {
			const _this = this;

			const apiPath = gameName ? `privatechat/${gameName}` : 'chat';
			const apiProtocol = document.location.protocol === 'http:' ? 'ws:' : 'wss:';
			_this.events = new WebSocket(`${apiProtocol}//${location.host}/api/${apiPath}`);
			_this.events.onmessage = handleIncomingEvent;

			_this.sendEvent = function sendEvent(message) {
				_this.events.send(JSON.stringify({ message }));
			};

			function handleIncomingEvent(event) {
				const { type, ...payload } = JSON.parse(event.data);

				if (type === 'chatmessage') {
					handleChatMessageEvent(payload);
				}
			}

			function handleChatMessageEvent(payload) {
				_this.chatHistory.push({
					message: payload.message,
					player: payload.player,
				});

				_this.$nextTick(() => {
					_this.$refs.chatHistory.scrollTop = _this.$refs.chatHistory.scrollHeight;
				});
			}
		},
	}));
});
