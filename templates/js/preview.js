let vscode;
if (typeof acquireVsCodeApi !== "undefined") vscode = acquireVsCodeApi();

let zoomer;
let switcher;
let settings;

let previewStatus = defaultStatus();
// the error image is shown, its status is not saved
let showingErrorImage = false;
let renderSeq = 0;

function defaultStatus() {
    return {
        page: 1,
        pageStatus: {}
    }
}

function parseStatus(text) {
    try {
        let status = JSON.parse(text);
        if (status && status.pageStatus) return status;
    } catch (error) {
        // console.log("parse preview status error:", error.message);
    }
    return defaultStatus();
}

function throttle(fn, delay, atleast) {
    var timeout = null,
        startTime = new Date();
    return function (...args) {
        var curTime = new Date();
        clearTimeout(timeout);
        if (curTime - startTime >= atleast) {
            fn(...args);
            startTime = curTime;
        } else {
            timeout = setTimeout(fn, delay, ...args);
        }
    }
}


// record the status of current page into previewStatus
function captureStatus() {
    if (!switcher || !switcher.current || !zoomer.status || showingErrorImage) return false;
    previewStatus.page = switcher.current;

    let img = zoomer.img;
    let winWidth = window.innerWidth;
    let minWidth = winWidth < img.naturalWidth ? winWidth : img.naturalWidth;
    let minZoom = minWidth / img.naturalWidth * 100;
    if (zoomer.status.zoom < minZoom + 0.1 && !zoomer.status.x && !zoomer.status.y)
        previewStatus.pageStatus[switcher.current] = undefined;
    else
        previewStatus.pageStatus[switcher.current] = zoomer.status;
    return true;
}

var saveStatus = throttle(() => {
    if (vscode && captureStatus()) {
        // console.log("save status: ", previewStatus);
        vscode.postMessage(previewStatus);
    }
}, 500, 1000);

function preloadImage(src) {
    let img = new Image();
    img.src = src;
    return img.decode().catch(() => { });
}

function showContent(visible) {
    let display = visible ? "" : "none";
    document.getElementById("image-container").style.display = display;
    document.getElementById("ctrl-container").style.display = display;
}

/**
 * update the page with a render message from the extension
 * @param msg { pages: [{ src, map }], error, imageError, showSpinner, status }
 */
async function render(msg) {
    let seq = ++renderSeq;
    let pages = msg.pages || [];
    let hasError = !!(msg.error && msg.error.trim());
    let errorImage = !pages.length && hasError && !!msg.imageError;
    let images = errorImage ? [{ src: msg.imageError }] : pages;

    // decode new images first, the current ones are shown meanwhile
    await Promise.all(images.map(i => switcher.prepare(i)));
    if (seq !== renderSeq) return;

    document.getElementById("errtxt").innerText = msg.error || "";
    let imgErr = document.getElementById("image-error");
    if (msg.imageError) imgErr.src = msg.imageError; else imgErr.removeAttribute("src");
    document.getElementById("error-warning").style.display = hasError ? "" : "none";

    let spinner = document.getElementById("spinner-container");
    spinner.style.display = msg.showSpinner ? "" : "none";
    spinner.classList.toggle("small", images.length > 0);

    if (msg.status !== undefined) {
        // diagram changed, or page reloaded
        previewStatus = parseStatus(msg.status);
    } else {
        // keep current zoom, the saved status is throttled
        if (zoomer.pending) zoomer.commit();
        captureStatus();
    }
    if (errorImage) previewStatus = defaultStatus();
    showingErrorImage = errorImage;

    switcher.setImages(images);
    showContent(images.length > 0);
    if (images.length) switcher.moveTo(previewStatus.page);
}

window.addEventListener("load", () => {
    switcher = new Switcher();
    previewStatus = parseStatus(document.getElementById("status").innerHTML);
    settings = JSON.parse(document.getElementById("settings").innerHTML);

    document.getElementById("error-warning").style.display = "none";
    document.getElementById("image-container").style.margin = "0";
    showContent(false);

    zoomer = new Zoom(settings);
    addCursorManager(settings);
    // before links: ctrl-click on a linked element goes to its source
    addSourceNavigation(vscode);
    addHyperlinkManager(vscode);
    addSelectionBox(settings);
    addDrageScroll(settings);
    initializeHelpModal();

    // see imageMapResizer.js
    // the map is also resized by zoom.js once a zoom is committed, so only
    // watch "src" here: watching "style" resized it on every zoom step.
    imageMapResize('#image-map');
    let image = document.getElementById('image')
    if (image) {
        new MutationObserver(() => {
                imageMapResize('#image-map');
        })
        .observe(
            image,
            {'attributes': true, 'attributeFilter': ['src']}
        );
    }

    window.addEventListener("message", e => {
        if (e.data && e.data.action == "render") render(e.data);
    });
    if (vscode) vscode.postMessage({ action: "ready" });
});
window.addEventListener(
    "resize",
    (function () {
        let onResizeAvailable = false;
        setTimeout(() => {
            onResizeAvailable = true;
        }, 300);
        return function (e) {
            if (!onResizeAvailable) {
                // block unwanted resize event triggered when page initializes.
                // console.log("rejected resize event.");
                return;
            }
            if (!switcher.images.length) return;
            zoomer.reset();
            previewStatus.pageStatus = {};
            saveStatus();
        }
    })()
);
