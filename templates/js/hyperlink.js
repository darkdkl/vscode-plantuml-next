function addHyperlinkManager(vscode) {
    let imgContainer= document.getElementById('image-container');

    // returns the link url of an image map <area>, or of an <a> in an inline SVG
    let linkOf = e => {
        if (e.button != 0) return undefined;
        if (e.target.target == "_blank") return e.target.href;
        // inline SVGs are in a shadow root, e.target is the host
        for (let el of e.composedPath()) {
            if (el === imgContainer) break;
            if (el.localName != "a" || !(el instanceof SVGElement)) continue;
            let href = el.getAttribute("href") || el.getAttributeNS("http://www.w3.org/1999/xlink", "href");
            return href ? new URL(href, document.baseURI).href : undefined;
        }
        return undefined;
    }

    imgContainer.addEventListener('click', e => {
        let href = linkOf(e);
        if (href) {
            vscode.postMessage({
                "action": "openExternalLink",
                "href": href
            });

            // do not navigate the preview itself
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    });

    imgContainer.addEventListener('mousedown', e => {
        if (linkOf(e)) {
            // prevent zoom selection when clicking on links
            e.stopImmediatePropagation();
        }
    });

    imgContainer.addEventListener('mouseup', e => {
        if (linkOf(e)) {
            // prevent zoom action when clicking on links
            e.stopImmediatePropagation();
        }
    });
}
