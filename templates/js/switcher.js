class Switcher {
    constructor() {
        this.current = 0;
        // [{ src, map }]
        this.images = [];
        this.image = document.getElementById("image");
        this.imageMap = document.getElementById("image-map");
        this.pInfo = document.getElementById("pageInfo");
        this.pInfoTpl = this.pInfo.innerText;
        this.pageCtrls = document.getElementById("page-ctrls");
        this.pageCtrls.style.display = "none";
        this.restoring = undefined;
        // the inline SVG shown instead of this.image, see svgImage.js
        this.svgImage = undefined;
        document.getElementById("btnNext").addEventListener("click", () => {
            if (this.current == this.images.length) return;
            // saveStatus() is throttled, record the leaving page now
            captureStatus();
            this.moveTo(this.current + 1);
            saveStatus();
        });
        document.getElementById("btnPrev").addEventListener("click", () => {
            if (this.current == 1) return;
            // saveStatus() is throttled, record the leaving page now
            captureStatus();
            this.moveTo(this.current - 1);
            saveStatus();
        });
    }
    /**
     * prepare a page to be shown: decode the image, or build its inline SVG
     * @param image { src, map }
     */
    async prepare(image) {
        if (image.svgImage !== undefined) return;
        image.svgImage = null;
        if (isSVGSource(image.src)) {
            try {
                image.svgImage = await createSVGImage(image.src) || null;
            } catch (error) {
                console.log("inline svg failed, fallback to <img>:", error);
            }
        }
        if (!image.svgImage) await preloadImage(image.src);
    }
    setImages(images) {
        this.images = images;
        // force the next moveTo() to switch, even to the same page
        this.current = 0;
        this.pageCtrls.style.display = images.length > 1 ? "" : "none";
    }
    moveTo(page) {
        if (page < 1 || page > this.images.length) {
            console.log(`invalid page: target ${page}, range 1 - ${this.images.length}`);
            if (page < 1) this.moveTo(1); else this.moveTo(this.images.length);
            return;
        }
        if (this.current == page) return;

        // switch page
        let image = this.images[page - 1];

        if (image.svgImage) {
            // links are in the SVG, no image map
            this.showSVGImage(image.svgImage);
            this.imageMap.innerHTML = "";
        } else {
            this.showSVGImage(undefined);
            if (this.image.getAttribute("src") !== image.src) this.image.src = image.src;
            this.imageMap.innerHTML = image.map ? parseMap(image.map) : "";
        }
        this.pInfo.innerText = String.format(this.pInfoTpl, page, this.images.length);
        this.current = page;
        reportSourceEntities();

        // restore page status, once the image size is known
        let restore = () => {
            if (this.restoring !== restore) return;
            this.restoring = undefined;
            let status = previewStatus.pageStatus[page];
            if (
                !status ||
                (status.snapLeft && status.snapRight && status.snapTop && status.snapBottom)
            ) {
                zoomer.reset();
            } else {
                zoomer.applyStatus(status);
            }
        }
        this.restoring = restore;
        if (image.svgImage || (this.image.complete && this.image.naturalWidth))
            restore();
        else
            this.image.addEventListener("load", restore, { once: true });
    }
    showSVGImage(svgImage) {
        if (this.svgImage === svgImage) return;
        if (this.svgImage) this.svgImage.remove();
        this.svgImage = svgImage;
        if (svgImage) {
            this.image.after(svgImage);
            this.image.style.display = "none";
            // free the decoded image of the previous page
            this.image.removeAttribute("src");
        } else {
            this.image.style.display = "";
        }
        zoomer.img = svgImage || this.image;
    }
}

// returns the inner html of a "<map>...</map>" string
function parseMap(html) {
    let tpl = document.createElement("template");
    tpl.innerHTML = html;
    let map = tpl.content.querySelector("map");
    return map ? map.innerHTML : "";
}

String.format = function format() {
    if (arguments.length == 0)
        return null;

    var str = arguments[0];
    for (var i = 1; i < arguments.length; i++) {
        var re = new RegExp('\\{' + (i - 1) + '\\}', 'gm');
        str = str.replace(re, arguments[i]);
    }
    return str;
}
