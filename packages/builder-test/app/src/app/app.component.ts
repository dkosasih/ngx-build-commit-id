import { versions } from '../environments/versions';
import { Component } from '@angular/core';
@Component({
    selector: 'app-root',
    templateUrl: './app.component.html',
    styleUrls: ['./app.component.scss']
})
export class AppComponent {
    constructor() {
        console.info(`%c Running revision: ${versions.revision}; Branch: ${versions.branch} `, 'background-color: darkblue; color: white;');
    }
    title = 'app';
}
