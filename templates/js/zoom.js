// While zooming, the image is only scaled with a CSS transform, which is done by
// the compositor and does not re-rasterize the SVG. The real size is applied
// ("committed") once the zoom settles, so large diagrams are rasterized once per
// gesture instead of once per wheel event / animation step.
// Longer than the gap between mouse wheel notches, or each notch is committed.
const COMMIT_DELAY = 400;
// Commit earlier if the transform scale drifts too far from the rasterized size,
// to limit both blurriness (zoom in) and raster cost (zoom out).
const MAX_PREVIEW_SCALE = 2;
const SMOOTH_ZOOM_DURATION = 100;

class Zoom {
    constructor(settings) {
        this.settings = settings;
        this.img = document.getElementById("image");
        this.imageMap = document.getElementById("image-map");
        this.imgContainer = document.getElementById("image-container");
        this.iconToggle = document.getElementById("icon-toggle");
        this.ctrlBar = document.getElementById("ctrl-container");
        this.snapIndicator = document.getElementById("snap-indicator-container");

        this.mouseZoomButton = settings.swapMouseButtons ? 2 : 0;
        this.mouseResetZoomButton = 1;

        // committed status
        this.status = undefined;
        // previewed (transformed) but not yet committed status
        this.pending = undefined;
        this.commitTimer = undefined;
        this.animation = undefined;
        // committed image rect, in document coordinates
        this.view = { left: 0, top: 0, width: 0, height: 0 };
        // image position not caused by its margins (container offsets etc.)
        this.viewOffset = { x: 0, y: 0 };
        this.containerOffset = { x: 0, y: 0 };
        // measured lazily, the bar may be hidden until there is an image
        this.ctrlBarSpaceY = undefined;

        let resetZoom = () => {
            this.reset();
        }
        let onclick = e => {
            if (e.button == this.mouseZoomButton) {
                let scale = 1 + (e.altKey ? -0.2 : 0.2);
                this.smoothZomm(this.zoom * scale, this.getMousePointer(e.clientX, e.clientY));
            } else if (e.button == this.mouseResetZoomButton) {
                if (this.isImageExpanded())
                    resetZoom();
                else
                    this.smoothZomm(100, this.getMousePointer(e.clientX, e.clientY));
            }
        }
        let ondblclick = e => {
            if (this.isImageExpanded())
                resetZoom();
            else
                this.smoothZomm(100, this.getMousePointer(e.clientX, e.clientY));
        }
        addClickEvent(this.imgContainer, onclick);
        document.getElementById("btnZoomIn").addEventListener("click", () => {
            this.smoothZomm(this.zoom * 1.2, this.getWindowCenterMousePointer());
        });
        document.getElementById("btnZoomOut").addEventListener("click", () => {
            this.smoothZomm(this.zoom / 1.2, this.getWindowCenterMousePointer());
        });
        let btnCopy = document.getElementById("btnCopy");
        btnCopy.addEventListener("click", () => {
            this.copyImage(this.img, {
                copying: btnCopy.dataset.labelCopying,
                ok: btnCopy.dataset.labelOk,
                fail: btnCopy.dataset.labelFail,
            });
        });
        document.getElementById("btnZoomToggle").addEventListener("click", () => {
            if (this.isImageExpanded()) {
                resetZoom();
            } else
                this.smoothZomm(100, this.getWindowCenterMousePointer());
        });
        document.body.addEventListener("mousewheel", e => {
            // console.log(e.ctrlKey, e.wheelDeltaX, e.wheelDeltaY);
            // scroll to zoom, or ctrl key pressed scroll
            if (e.ctrlKey) {
                // ctrlKey == true: pinch
                let delta = e.wheelDelta / 60;
                let mouseAt = this.getMousePointer(e.clientX, e.clientY);
                if (this.settings.zoomUpperLimit) {
                    this.pointZoom(this.zoom + delta, mouseAt, false);
                } else {
                    // zoom level increase / decrease by 30% for each wheel scroll
                    this.pointZoom(this.zoom * (delta / 50 + 1), mouseAt, false);
                }
                e.preventDefault();
                return false;
            }
        }, { passive: false });
        window.addEventListener("scroll", () => {
            if (this.pending) {
                // scrolled (wheel, drag) while previewing: keep the offset and commit
                let dx = window.scrollX - this.pending.scrollX;
                let dy = window.scrollY - this.pending.scrollY;
                if (!dx && !dy) return;
                this.pending.status.x += dx;
                this.pending.status.y += dy;
                this.commit();
            }
            if (!this.status) return;
            this.status.x = window.scrollX;
            this.status.y = window.scrollY;
            this.calcSnap();
            saveStatus();
        });
    }
    get zoom() {
        return this.pending ? this.pending.status.zoom : this.status.zoom;
    }
    reset() {
        this.pointZoom(0);
        this.calcSnap();
    }
    calcSnap() {
        this.status.snapLeft = Math.abs(this.status.x) < 5;
        this.status.snapTop = Math.abs(this.status.y) < 5;
        this.status.snapRight = Math.abs(
            this.status.imgWidth + this.status.blankLeft + this.status.blankRight -
            this.status.x - window.innerWidth
        ) < 5;
        this.status.snapBottom = Math.abs(
            this.status.imgHeight + this.status.blankBottom + this.status.blankTop -
            this.status.y - window.innerHeight
        ) < 5;
        if (!this.settings.showSnapIndicators) return;
        if (this.status.snapBottom !== this.status.snapTop) {
            if (this.status.snapBottom) {
                this.snapIndicator.classList.add('snap-bottom');
                this.snapIndicator.classList.remove('snap-top');
            } else {
                this.snapIndicator.classList.add('snap-top');
                this.snapIndicator.classList.remove('snap-bottom');
            }
        } else {
            this.snapIndicator.classList.remove('snap-top');
            this.snapIndicator.classList.remove('snap-bottom');
        }
        if (this.status.snapRight !== this.status.snapLeft) {
            if (this.status.snapRight) {
                this.snapIndicator.classList.add('snap-right');
                this.snapIndicator.classList.remove('snap-left');
            } else {
                this.snapIndicator.classList.add('snap-left');
                this.snapIndicator.classList.remove('snap-right');
            }
        } else {
            this.snapIndicator.classList.remove('snap-left');
            this.snapIndicator.classList.remove('snap-right');
        }
    }
    smoothZomm(to, mouseAt) {
        let minZoom = this.getMinZoom();
        if (to < minZoom) to = minZoom;
        let from = this.zoom;
        if (from == to) return;
        let animation = {};
        let start = undefined;
        let step = now => {
            if (this.animation !== animation) return;
            if (start === undefined) start = now;
            let progress = Math.min((now - start) / SMOOTH_ZOOM_DURATION, 1);
            let done = progress >= 1;
            if (done) this.animation = undefined;
            // only the last frame is committed
            this.zoomTo(from + (to - from) * progress, mouseAt, done);
            if (!done) requestAnimationFrame(step);
        };
        this.animation = animation;
        requestAnimationFrame(step);
    }
    rectZoom(start, end) {
        this.animation = undefined;
        let minZoom = this.getMinZoom();
        const maxZoom = 100;

        let status = this.getRectZoomStatus(start, end);
        if (this.settings.zoomUpperLimit && status.zoom > maxZoom) status.zoom = maxZoom;
        if (status.zoom < minZoom) status.zoom = minZoom;

        this.applyStatus(status);
    }
    /**
     * zoom at point
     * @param zoom the zoom level
     * @param point the point to zoom at, defaults to window center
     * @param immediate apply the zoom at once, or preview it and commit later
     */
    pointZoom(zoom, point, immediate = true) {
        this.animation = undefined;
        return this.zoomTo(zoom, point, immediate);
    }
    zoomTo(zoom, point, immediate) {
        let minZoom = this.getMinZoom();
        const maxZoom = 100;

        if (!point) point = this.getWindowCenterMousePointer();
        if (this.settings.zoomUpperLimit && zoom > maxZoom) zoom = maxZoom;
        if (zoom < minZoom + 0.1) {
            // if zoom <= minZoom, reset
            zoom = minZoom;
            let imgHeight = this.img.naturalHeight * zoom / 100;
            point = this.getWindowCenterMousePointer();
            point.imageX = 0.5;
            if (imgHeight < window.innerHeight) {
                point.imageY = 0.5;
            } else {
                point.y = 0;
                point.imageY = 0;
            }
        }

        let status = this.getPointZoomStatus(zoom, point);
        if (immediate)
            this.applyStatus(status);
        else
            this.showPreview(status);
        return true;
    }
    getMinZoom() {
        let winWidth = window.innerWidth;
        let minWidth = winWidth < this.img.naturalWidth ? winWidth : this.img.naturalWidth;
        return minWidth / this.img.naturalWidth * 100;
    }
    getRectZoomStatus(start, end) {
        let startPoint = this.getMousePointer(start.x, start.y);
        let endPoint = this.getMousePointer(end.x, end.y);
        let rect = this.getImageRect();
        let imgSelCenterX = startPoint.imageX + (endPoint.imageX - startPoint.imageX) / 2;
        let imgSelCenterY = startPoint.imageY + (endPoint.imageY - startPoint.imageY) / 2;
        let imgX = (endPoint.imageX - startPoint.imageX) * rect.width;
        let imgY = (endPoint.imageY - startPoint.imageY) * rect.height;
        let scaleX = window.innerWidth / imgX;
        let scaleY = window.innerHeight / imgY;
        let scale = Math.min(scaleX, scaleY);
        let zoom = this.zoom * scale;
        let point = this.getWindowCenterMousePointer();
        point.imageX = imgSelCenterX;
        point.imageY = imgSelCenterY;
        return this.getPointZoomStatus(zoom, point);
    }
    getPointZoomStatus(zoom, point) {
        let imgWidth = this.img.naturalWidth * zoom / 100;
        let imgHeight = this.img.naturalHeight * zoom / 100;
        if (this.ctrlBarSpaceY === undefined)
            this.ctrlBarSpaceY = window.innerHeight - this.ctrlBar.offsetTop;
        let ctrlBarSapceY = this.ctrlBarSpaceY;

        let blankRight = Math.floor(window.innerWidth - imgWidth * (1 - point.imageX) - point.x);
        let blankLeft = Math.floor(point.x - imgWidth * point.imageX);
        let blankBottom = Math.floor(window.innerHeight - imgHeight * (1 - point.imageY) - point.y);
        let blankTop = Math.floor(point.y - imgHeight * point.imageY);
        blankRight = blankRight < 0 ? 0 : blankRight;
        blankLeft = blankLeft < 0 ? 0 : blankLeft;
        blankBottom = blankBottom < ctrlBarSapceY ? ctrlBarSapceY : blankBottom;
        blankTop = blankTop < 0 ? 0 : blankTop;

        let status = {};
        status.imgWidth = imgWidth;
        status.imgHeight = imgHeight;
        status.blankTop = blankTop;
        status.blankRight = blankRight;
        status.blankBottom = blankBottom;
        status.blankLeft = blankLeft;
        status.x = Math.floor(imgWidth * point.imageX + status.blankLeft - point.x);
        status.y = Math.floor(imgHeight * point.imageY + status.blankTop - point.y);
        status.zoom = zoom
        return status;
    }
    getStatusScroll(status) {
        let scrollX = 0;
        let scrollY = 0;
        if (status.snapLeft === status.snapRight)
            // snapLeft & snapLeft all true => image width small than window, no snap
            // snapLeft & snapLeft all false => of course no snap
            scrollX = status.x;
        else if (status.snapLeft)
            scrollX = 0;
        else if (status.snapRight)
            scrollX = status.imgWidth + status.blankLeft + status.blankRight;

        if (status.snapTop === status.snapBottom)
            // snapLeft & snapLeft all true => image height small than window, no snap
            // snapLeft & snapLeft all false => of course no snap
            scrollY = status.y;
        else if (status.snapTop)
            scrollY = 0;
        else if (status.snapBottom)
            scrollY = status.imgHeight + status.blankTop + status.blankBottom;
        return { x: scrollX, y: scrollY };
    }
    /**
     * show the status with a transform on the committed image, without any
     * layout or raster work, and schedule a commit.
     */
    showPreview(status) {
        let base = this.getCommittedRect();
        if (!this.status || !base.width || !base.height) {
            this.applyStatus(status);
            return;
        }
        status.imgWidth = this.img.naturalWidth * status.zoom / 100;
        status.imgHeight = this.img.naturalHeight * status.zoom / 100;

        // where the image will be after commit, in viewport coordinates
        let scroll = this.getStatusScroll(status);
        let docWidth = this.viewOffset.x + status.blankLeft + status.imgWidth + status.blankRight;
        let docHeight = this.viewOffset.y + status.blankTop + status.imgHeight + status.blankBottom;
        scroll.x = Math.max(0, Math.min(scroll.x, docWidth - window.innerWidth));
        scroll.y = Math.max(0, Math.min(scroll.y, docHeight - window.innerHeight));
        let rect = {
            left: this.viewOffset.x + status.blankLeft - scroll.x,
            top: this.viewOffset.y + status.blankTop - scroll.y,
            width: status.imgWidth,
            height: status.imgHeight,
        };

        let scale = rect.width / base.width;
        // transform the container rather than the <img>: a transformed SVG <img>
        // is repainted on the main thread on every scale change, while the
        // container's layer is only scaled by the compositor.
        let origin = this.containerOffset;
        this.imgContainer.style.transformOrigin = `${origin.x}px ${origin.y}px`;
        this.imgContainer.style.transform = `translate(${rect.left - base.left}px, ${rect.top - base.top}px) scale(${scale})`;
        this.pending = {
            status: status,
            rect: rect,
            scrollX: window.scrollX,
            scrollY: window.scrollY,
        };

        clearTimeout(this.commitTimer);
        if (scale > MAX_PREVIEW_SCALE || scale < 1 / MAX_PREVIEW_SCALE)
            this.commit();
        else
            this.commitTimer = setTimeout(() => this.commit(), COMMIT_DELAY);
    }
    commit() {
        if (!this.pending) return;
        this.applyStatus(this.pending.status);
        saveStatus();
    }
    cancelPreview() {
        clearTimeout(this.commitTimer);
        this.commitTimer = undefined;
        this.pending = undefined;
        this.imgContainer.style.transform = "";
    }
    applyStatus(status) {
        // console.log("apply status:", status);
        this.cancelPreview();
        let imgWidth = this.img.naturalWidth * status.zoom / 100;
        let imgHeight = this.img.naturalHeight * status.zoom / 100;
        // update image size of saved status, since image may updated
        status.imgWidth = imgWidth;
        status.imgHeight = imgHeight;

        this.img.style.width = imgWidth + 'px';
        // an <img> keeps its aspect ratio, an inline SVG host doesn't
        this.img.style.height = imgHeight + 'px';
        this.img.style.marginLeft = status.blankLeft + 'px';
        this.img.style.marginRight = status.blankRight + 'px';
        this.img.style.marginTop = status.blankTop + 'px';
        this.img.style.marginBottom = status.blankBottom + 'px';

        let scroll = this.getStatusScroll(status);
        window.scrollTo(scroll.x, scroll.y);
        // the scroll position may be clamped by the browser
        status.x = window.scrollX;
        status.y = window.scrollY;

        this.status = status;
        this.measure();
        this.calcSnap();
        this.setToggleIcon();
        this.resizeImageMap();
    }
    // read layout once per commit, so that zoom previews never have to
    measure() {
        let rect = this.img.getBoundingClientRect();
        this.view = {
            left: rect.left + window.scrollX,
            top: rect.top + window.scrollY,
            width: rect.width,
            height: rect.height,
        };
        this.viewOffset = {
            x: this.view.left - this.status.blankLeft,
            y: this.view.top - this.status.blankTop,
        };
        // image position in the container, the origin of preview transforms
        let container = this.imgContainer.getBoundingClientRect();
        this.containerOffset = {
            x: rect.left - container.left,
            y: rect.top - container.top,
        };
        this.ctrlBarSpaceY = window.innerHeight - this.ctrlBar.offsetTop;
    }
    resizeImageMap() {
        if (!this.imageMap || !this.imageMap.areas.length) return;
        if (typeof imageMapResize !== "function") return;
        imageMapResize(this.imageMap);
    }
    getCommittedRect() {
        return {
            left: this.view.left - window.scrollX,
            top: this.view.top - window.scrollY,
            width: this.view.width,
            height: this.view.height,
        };
    }
    // the image rect as it's shown, in viewport coordinates
    getImageRect() {
        return this.pending ? this.pending.rect : this.getCommittedRect();
    }
    getMousePointer(x, y) {
        let rect = this.getImageRect();
        return {
            x: x,
            y: y,
            imageX: (x - rect.left) / rect.width,
            imageY: (y - rect.top) / rect.height,
        }
    }
    getWindowCenterMousePointer() {
        let x = window.innerWidth / 2;
        let y = window.innerHeight / 2;
        return this.getMousePointer(x, y);
    }
    setToggleIcon() {
        let icon = "fullscreen";
        if (Math.round(this.view.width) >= this.img.naturalWidth || window.scrollX != 0 || window.scrollY != 0) {
            icon = "fullscreen_exit";
        }
        if (this.iconToggle.innerText != icon) this.iconToggle.innerText = icon;
    }
    isImageExpanded() {
        return this.iconToggle.innerText == "fullscreen_exit";
    }
    async copyImage(img, labels) {
        showTip(labels.copying, -1);
        // an inline SVG can't be drawn to canvas, draw its source instead
        let source = img;
        if (img.imageSrc) {
            source = new Image();
            source.src = img.imageSrc;
            try {
                await source.decode();
            } catch (error) {
                showTip(labels.fail + ": " + error, 2000);
                return;
            }
        }
        const maxSize = 8192;
        let scale = Math.min(maxSize / img.clientWidth, maxSize / img.clientHeight, 1)
        let width = img.clientWidth * scale;
        let height = img.clientHeight * scale;
        // console.log(img.clientWidth, "*", img.clientHeight, " => ", width, "*", height)
        let canvas = document.createElement("canvas");
        document.body.appendChild(canvas);
        canvas.width = width;
        canvas.height = height;
        var ctx = canvas.getContext("2d");
        ctx.drawImage(source, 0, 0, source.naturalWidth, source.naturalHeight, 0, 0, width, height);
        canvas.toBlob(function (blob) {
            if (!blob) {
                showTip(labels.fail, 2000);
                return;
            }
            let data = [new ClipboardItem({
                [blob.type]: blob
            })];
            navigator.clipboard.write(data).then(function () {
                showTip(labels.ok, 2000);
            }, function (err) {
                showTip(labels.fail + ": " + err, 2000);
            }).then(function () {
                document.body.removeChild(canvas);
            })
        }, 1);
    }
}