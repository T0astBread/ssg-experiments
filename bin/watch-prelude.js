process.on("message", ({ event, data }) => {
	switch (event) {
		case "start":
			require(data)
			break
		case "buildscript-failure":
			process.emit(event, data)
			break
	}
})
// process.on("message", require)
