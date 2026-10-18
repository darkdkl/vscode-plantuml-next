function addCursorManager(settings) {
    let imgContainer = document.getElementById('image-container')
    let cursor = "";
    // mousemove fires a lot, only touch the style when the cursor changes
    let setCursor = value => {
        if (cursor === value) return;
        cursor = value;
        imgContainer.style.cursor = value;
    }
    let decideCursor = (e) => {
        let leftButton = e.buttons & 1;
        let rightButton = e.buttons & 2;
        // console.log("leftButton", leftButton, "rightButton", rightButton);
        if (!leftButton && !rightButton) {
            if (settings.swapMouseButtons) {
                setCursor("grab");
            } else if (e.altKey) {
                setCursor("zoom-out");
            } else {
                setCursor("zoom-in");
            }
            return;
        }
        // zoom
        if (
            (leftButton && !settings.swapMouseButtons) ||
            (rightButton && settings.swapMouseButtons)
        ) {
            if (e.altKey) {
                setCursor("zoom-out");
            } else {
                setCursor("zoom-in");
            }
            return;
        }
        // move
        if (
            (leftButton && settings.swapMouseButtons) ||
            (rightButton && !settings.swapMouseButtons)
        ) {
            setCursor("grabbing");
        } else {
            setCursor("grab");
        }
    }
    imgContainer.addEventListener("mousedown", e => {
        // console.log("mousedown", e.button, e.buttons);
        decideCursor(e);
    });
    imgContainer.addEventListener("mousemove", e => {
        // console.log("mousemove", e.button, e.buttons);
        decideCursor(e);
    });
    imgContainer.addEventListener("mouseup", e => {
        // console.log("mousemove", e.button, e.buttons);
        decideCursor(e);
    });
};