/**
 * chat-gifs.js — Static GIF library for the in-game chat picker.
 * Add new GIF URLs to CHAT_GIFS to make them appear in the picker.
 * Supported CDNs: media.giphy.com, media.tenor.com
 */
window.CHAT_GIFS = [
    'https://media.giphy.com/media/v1.Y2lkPWVjZjA1ZTQ3bTVvYW5qNjR1Z2Z0ZDZ2czRnMWdmaTk0NG9hc3h0bnljNHJzaG1mbiZlcD12MV9naWZzX3NlYXJjaCZjdD1n/DgCnVWHGGrsuoZBgYV/giphy.gif',
    'https://media.giphy.com/media/v1.Y2lkPWVjZjA1ZTQ3N3Y1dHNoano3ZXA4M2hkN2gyd3R5dTFwMjV3azVydG85Z2Y0ZGM2dSZlcD12MV9naWZzX3NlYXJjaCZjdD1n/VNjiPultCB4RBUYVxf/giphy.gif',
    'https://media.giphy.com/media/v1.Y2lkPWVjZjA1ZTQ3N3Y1dHNoano3ZXA4M2hkN2gyd3R5dTFwMjV3azVydG85Z2Y0ZGM2dSZlcD12MV9naWZzX3NlYXJjaCZjdD1n/HyNmN4OOwC1kI7VK7M/giphy.gif',
    'https://media.giphy.com/media/v1.Y2lkPWVjZjA1ZTQ3eXdubjgyeG9sYmJxdzZ2c3AwbzFiZzg4eGR5anlrMjN4bjUxaXJmdCZlcD12MV9naWZzX3NlYXJjaCZjdD1n/J6I13QPaCvc77NhhPb/giphy.gif',
    'https://media.giphy.com/media/v1.Y2lkPWVjZjA1ZTQ3eXdubjgyeG9sYmJxdzZ2c3AwbzFiZzg4eGR5anlrMjN4bjUxaXJmdCZlcD12MV9naWZzX3NlYXJjaCZjdD1n/LGpkntAwrj3RDUM11r/giphy.gif',
    'https://media.giphy.com/media/v1.Y2lkPWVjZjA1ZTQ3eXdubjgyeG9sYmJxdzZ2c3AwbzFiZzg4eGR5anlrMjN4bjUxaXJmdCZlcD12MV9naWZzX3NlYXJjaCZjdD1n/3oKIPiqfUtLCnIKxRS/giphy.gif',
    'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExbWRqZmt5em54d25qZTdlamMwNHd6a3B5dTZvZzZtZndjODM4aHN3aCZlcD12MV9naWZzX3NlYXJjaCZjdD1n/XrNry0aqYWEhi/giphy.gif',
    'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExbWRqZmt5em54d25qZTdlamMwNHd6a3B5dTZvZzZtZndjODM4aHN3aCZlcD12MV9naWZzX3NlYXJjaCZjdD1n/YA6dmVW0gfIw8/giphy.gif',
    'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExbWRqZmt5em54d25qZTdlamMwNHd6a3B5dTZvZzZtZndjODM4aHN3aCZlcD12MV9naWZzX3NlYXJjaCZjdD1n/jmSImqrm28Vdm/giphy.gif',
    'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExbWRqZmt5em54d25qZTdlamMwNHd6a3B5dTZvZzZtZndjODM4aHN3aCZlcD12MV9naWZzX3NlYXJjaCZjdD1n/KzKXmxsMue4CSxzYBK/giphy.gif',
    'https://media.giphy.com/media/v1.Y2lkPWVjZjA1ZTQ3YTRhcDlrbW9wMjg1ejZ1am00Z2s0dWs0NDJ2Nnh1Zmo0dnJxcGFxOCZlcD12MV9naWZzX3NlYXJjaCZjdD1n/hvrVRkDoXuTd2n6A2o/giphy.gif',
    'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExeTRwenZmeDNyZjk2bmt6dHdmMjQ5anhhbnAyZWV5d3I4M290ZThwZyZlcD12MV9naWZzX3NlYXJjaCZjdD1n/nrXif9YExO9EI/giphy.gif',
    'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExeTRwenZmeDNyZjk2bmt6dHdmMjQ5anhhbnAyZWV5d3I4M290ZThwZyZlcD12MV9naWZzX3NlYXJjaCZjdD1n/3o6ozh46EbuWRYAcSY/giphy.gif',
    'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExeTRwenZmeDNyZjk2bmt6dHdmMjQ5anhhbnAyZWV5d3I4M290ZThwZyZlcD12MV9naWZzX3NlYXJjaCZjdD1n/B0yHMGZZLbBxS/giphy.gif',
    'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExeTRwenZmeDNyZjk2bmt6dHdmMjQ5anhhbnAyZWV5d3I4M290ZThwZyZlcD12MV9naWZzX3NlYXJjaCZjdD1n/4TMqcN59kg3Yc/giphy.gif',
    'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNGprMXM5dzd0ZzBuaXAxbnpyNnBsMXNlbTJlcHFmODd5cnE1eW92dSZlcD12MV9naWZzX3NlYXJjaCZjdD1n/Rfwlp9c5bA7R3s7Y5D/giphy.gif',
    'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNGprMXM5dzd0ZzBuaXAxbnpyNnBsMXNlbTJlcHFmODd5cnE1eW92dSZlcD12MV9naWZzX3NlYXJjaCZjdD1n/UZxzsNx1kpZZwTCSSp/giphy.gif',
    'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNGprMXM5dzd0ZzBuaXAxbnpyNnBsMXNlbTJlcHFmODd5cnE1eW92dSZlcD12MV9naWZzX3NlYXJjaCZjdD1n/ybnrXkdf8jAxIkMuwr/giphy.gif',
    'https://media.giphy.com/media/v1.Y2lkPWVjZjA1ZTQ3NXMybmZ2ZDF2MTBxbmgxazJ0czBwMHZwZ3QzZHJ6aTgzamF2N2J4eCZlcD12MV9naWZzX3NlYXJjaCZjdD1n/MBNgMB6miNesE/giphy.gif',
    'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExZHF3eGdmd2R5dWJ6NXpxcDhqaGl6Mm53cjl6MXdiZ3R5dmMya3MxMCZlcD12MV9naWZzX3NlYXJjaCZjdD1n/2g6sCTsSoVuSfSxK4W/giphy.gif',
    'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExZHF3eGdmd2R5dWJ6NXpxcDhqaGl6Mm53cjl6MXdiZ3R5dmMya3MxMCZlcD12MV9naWZzX3NlYXJjaCZjdD1n/3oEjHI8WJv4x6UPDB6/giphy.gif',
    'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExZHF3eGdmd2R5dWJ6NXpxcDhqaGl6Mm53cjl6MXdiZ3R5dmMya3MxMCZlcD12MV9naWZzX3NlYXJjaCZjdD1n/FLKUJnRt6cGBG102B0/giphy.gif',
    'https://media.giphy.com/media/v1.Y2lkPWVjZjA1ZTQ3OHkyNGhjZWtqMXR6cmhxZXl5YnBobnJ6ZWRjODFobmJ2cm8zbWhsNyZlcD12MV9naWZzX3NlYXJjaCZjdD1n/bPLlVHjnlfS6m3wIjg/giphy.gif',
    'https://media.giphy.com/media/v1.Y2lkPWVjZjA1ZTQ3OHkyNGhjZWtqMXR6cmhxZXl5YnBobnJ6ZWRjODFobmJ2cm8zbWhsNyZlcD12MV9naWZzX3NlYXJjaCZjdD1n/CZoKT80OJCXPER2xxt/giphy.gif',
    'https://media.giphy.com/media/v1.Y2lkPWVjZjA1ZTQ3YWhuYWgwMnZyNWMzc3NmZ2lzYm01ZHczbXJrZXNsOWNqZzRzbHNkciZlcD12MV9naWZzX3NlYXJjaCZjdD1n/yBv1LrKkWDmU08iOJ8/giphy.gif',
    'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExZHF3eGdmd2R5dWJ6NXpxcDhqaGl6Mm53cjl6MXdiZ3R5dmMya3MxMCZlcD12MV9naWZzX3NlYXJjaCZjdD1n/EJIqwKKY30Dlu/giphy.gif',
    'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExeTRwenZmeDNyZjk2bmt6dHdmMjQ5anhhbnAyZWV5d3I4M290ZThwZyZlcD12MV9naWZzX3NlYXJjaCZjdD1n/yMWdlaSuPk7WkQaQBY/giphy.gif',
];
